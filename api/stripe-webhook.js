// api/stripe-webhook.js — Webhook Stripe : persistence commandes + loyalty + emails + jackpot
// Env requis : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, KV_REST_API_URL, KV_REST_API_TOKEN
// Env optionnel : RESEND_API_KEY (emails confirmation)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { sendEmail, orderConfirmationHtml, adminOrderHtml, ADMIN_EMAIL } = require('../lib/email');

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature' });

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      const { kv } = require('@vercel/kv');
      const email = session.customer_email || session.customer_details?.email;
      const customerName = session.customer_details?.name || '';

      const order = {
        ref: `EDN-${session.id.slice(-6).toUpperCase()}`,
        sessionId: session.id,
        amount: (session.amount_total / 100).toFixed(2),
        currency: session.currency,
        promoCode: session.metadata?.promoCode || '',
        prizeCode: session.metadata?.prizeCode || '',
        discountPct: session.metadata?.discountPct || '0',
        status: 'confirmed',
        provider: 'stripe',
        createdAt: new Date().toISOString(),
      };

      // Jackpot progressif : 1€ par commande alimente le pool
      try {
        const jackpotKey = 'jackpot:pool';
        const current = (await kv.get(jackpotKey)) || 0;
        await kv.set(jackpotKey, +(current + 1).toFixed(2));
      } catch {}

      if (email) {
        const key = `user:${email.toLowerCase().trim()}`;
        const user = await kv.get(key);
        if (user) {
          user.orders = user.orders || [];
          user.orders.unshift(order);
          const pts = Math.floor(parseFloat(order.amount));
          user.loyalty = (user.loyalty || 0) + pts;
          await kv.set(key, user);
          console.log(`Order ${order.ref} saved for ${email} (+${pts} pts loyalty)`);
        }

        // Email confirmation client
        await sendEmail({
          to: email,
          subject: `✅ Commande confirmée ${order.ref} — Eden Project TCG`,
          html: orderConfirmationHtml({
            ref: order.ref,
            name: customerName,
            amount: order.amount,
            provider: 'stripe',
          }),
        });
      }

      // Email notification admin
      await sendEmail({
        to: ADMIN_EMAIL,
        subject: `🛒 Nouvelle commande Stripe ${order.ref} — ${(session.amount_total / 100).toFixed(2)}€`,
        html: adminOrderHtml({
          ref: order.ref,
          customerEmail: email,
          customerName,
          amount: order.amount,
          provider: 'stripe',
          promoCode: order.promoCode,
          prizeCode: order.prizeCode,
        }),
      });

    } catch (err) {
      // Retourner 200 quand même — Stripe ne doit pas retenter pour une erreur KV
      console.error('Webhook processing failed:', err.message);
    }
  }

  return res.status(200).json({ received: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
