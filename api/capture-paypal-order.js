// api/capture-paypal-order.js — Capture PayPal + persistance commande + loyalty points + emails
// Env requis : PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV, SITE_URL
// Env optionnel : KV_REST_API_URL, KV_REST_API_TOKEN, RESEND_API_KEY

const { PAYPAL_BASE, getPayPalToken } = require('../lib/paypal');
const { sendEmail, orderConfirmationHtml, adminOrderHtml, ADMIN_EMAIL } = require('../lib/email');
const jwt = require('jsonwebtoken');
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Vérification JWT — obligatoire pour déclencher une capture
  const authHeader = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!authHeader) return res.status(401).json({ error: 'Authentification requise' });
  let decodedUser;
  try {
    decodedUser = jwt.verify(authHeader, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expirée — reconnectez-vous' });
  }

  const { orderId } = req.body || {};
  if (!orderId || typeof orderId !== 'string' || orderId.length > 64) {
    return res.status(400).json({ error: 'orderId invalide' });
  }

  try {
    const token = await getPayPalToken();
    const capture = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture-${orderId}`,
      },
    });
    const data = await capture.json();

    if (data.status !== 'COMPLETED') {
      const reason = data.details?.[0]?.description || data.message || 'Paiement non complété';
      console.error('PayPal capture non COMPLETED:', JSON.stringify(data));
      return res.status(402).json({ error: reason });
    }

    const captureDetail = data.purchase_units?.[0]?.payments?.captures?.[0];
    const amount = captureDetail?.amount?.value;
    const captureId = captureDetail?.id;
    const customId = data.purchase_units?.[0]?.custom_id || '';

    // Référence commande lisible
    const ref = `EDN-${(captureId || data.id).slice(-6).toUpperCase()}`;

    console.log(`PayPal captured: order=${data.id} capture=${captureId} amount=${amount} ref=${ref}`);

    // Persistance commande + loyalty points dans KV
    // Email : uniquement depuis les données KV stockées à la création (JWT-vérifié), jamais depuis le body
    try {
        const { kv } = require('@vercel/kv');

        // Verrou atomique NX : une seule capture peut s'exécuter par orderId
        const lockKey = `paypal:lock:${orderId}`;
        const locked = await kv.set(lockKey, 1, { nx: true, ex: 3600 });
        if (!locked) {
          console.warn(`PayPal capture ${orderId}: double-capture bloquée (verrou NX)`);
          return res.status(409).json({ error: 'Capture déjà en cours pour cette commande' });
        }

        // Récupérer les données stockées à la création de l'ordre PayPal
        const pendingKey = `paypal:order:${orderId}`;
        const pendingData = await kv.get(pendingKey);
        const orderItems = pendingData?.items || [];
        const pendingUserEmail = pendingData?.userEmail || '';
        const pendingPromoCode = pendingData?.promoCode || '';
        const pendingWonCodeIndex = pendingData?.wonCodeIndex ?? -1;

        // Source de confiance : email JWT stocké à la création, fallback custom_id PayPal (lui aussi from JWT)
        const userEmail = pendingUserEmail || (customId && EMAIL_RE.test(customId) ? customId : null);

        // Vérification croisée : le JWT doit correspondre au propriétaire de la commande
        if (userEmail && decodedUser.email.toLowerCase().trim() !== userEmail.toLowerCase().trim()) {
          console.warn(`PayPal capture ${orderId}: JWT email mismatch (${decodedUser.email} vs ${userEmail})`);
          return res.status(403).json({ error: 'Accès refusé' });
        }

        if (!userEmail) {
          console.warn(`PayPal capture ${orderId}: aucun email vérifié trouvé, commande non enregistrée`);
          return res.status(200).json({ ok: true, orderId: data.id, captureId, amount, ref });
        }

        const key = `user:${userEmail.toLowerCase().trim()}`;
        const user = await kv.get(key);

        const order = {
          ref,
          captureId,
          paypalOrderId: data.id,
          amount: parseFloat(amount || 0).toFixed(2),
          currency: captureDetail?.amount?.currency_code || 'EUR',
          status: 'confirmed',
          provider: 'paypal',
          createdAt: new Date().toISOString(),
          items: orderItems,
        };

        if (user) {
          user.orders = user.orders || [];
          user.orders.unshift(order);
          const pts = Math.floor(parseFloat(order.amount));
          user.loyalty = (user.loyalty || 0) + pts;

          // Marquer le code comme utilisé (tous types)
          if (pendingPromoCode && user.wonCodes) {
            const validIdx = pendingWonCodeIndex >= 0 && pendingWonCodeIndex < user.wonCodes.length
              ? pendingWonCodeIndex : -1;
            const idx = validIdx !== -1
              ? validIdx
              : user.wonCodes.findIndex(w => w.code === pendingPromoCode && !w.used);
            if (idx !== -1 && user.wonCodes[idx]) {
              user.wonCodes[idx].used = true;
              user.wonCodes[idx].usedAt = new Date().toISOString();
            }
          }

          // Jackpot progressif uniquement si commande bien enregistrée (évite rejeu)
          try {
            await kv.incrbyfloat('jackpot:pool', 1);
          } catch {}

          await kv.set(key, user);
          console.log(`PayPal order ${ref} saved for ${userEmail} (+${pts} pts loyalty)`);
        }

        // Nettoyer les données pending PayPal
        await kv.del(pendingKey).catch(() => {});

        // Email confirmation client
        await sendEmail({
          to: userEmail,
          subject: `✅ Commande confirmée ${ref} — Eden Project TCG`,
          html: orderConfirmationHtml({
            ref,
            name: user?.name || '',
            amount: order.amount,
            items: orderItems,
            provider: 'paypal',
          }),
        });

        // Email notification admin
        await sendEmail({
          to: ADMIN_EMAIL,
          subject: `🛒 Nouvelle commande PayPal ${ref} — ${order.amount}€`,
          html: adminOrderHtml({
            ref,
            customerEmail: userEmail,
            customerName: user?.name || '',
            amount: order.amount,
            provider: 'paypal',
          }),
        });

    } catch (kvErr) {
      console.error('KV/email failed (PayPal):', kvErr.message);
    }

    return res.status(200).json({ ok: true, orderId: data.id, captureId, amount, ref });
  } catch (err) {
    console.error('PayPal capture error:', err.message);
    return res.status(500).json({ error: 'Erreur lors de la capture du paiement' });
  }
};
