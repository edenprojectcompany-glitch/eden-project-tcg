// api/stripe-webhook.js — Webhook Stripe pour persistence commandes
// Env requis : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, KV_REST_API_URL, KV_REST_API_TOKEN
// Dans Vercel Dashboard : ajouter STRIPE_WEBHOOK_SECRET depuis stripe.com/webhooks

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
      if (email) {
        const key = `user:${email.toLowerCase().trim()}`;
        const user = await kv.get(key);
        if (user) {
          const order = {
            ref: `EDN-${session.id.slice(-6).toUpperCase()}`,
            sessionId: session.id,
            amount: (session.amount_total / 100).toFixed(2),
            currency: session.currency,
            promoCode: session.metadata?.promoCode || '',
            prizeCode: session.metadata?.prizeCode || '',
            discountPct: session.metadata?.discountPct || '0',
            status: 'confirmed',
            createdAt: new Date().toISOString(),
          };
          user.orders = user.orders || [];
          user.orders.unshift(order);
          // Points fidélité : 1pt par euro dépensé
          const pts = Math.floor(parseFloat(order.amount));
          user.loyalty = (user.loyalty || 0) + pts;
          await kv.set(key, user);
          console.log(`Order ${order.ref} saved for ${email} (+${pts} pts loyalty)`);
        }
      }
    } catch (err) {
      // Retourner 200 quand même — Stripe ne doit pas retenter pour une erreur KV
      console.error('KV write failed:', err.message);
    }
  }

  return res.status(200).json({ received: true });
}

// Vercel : désactive le body parsing pour lire le raw body (requis pour la signature Stripe)
handler.config = { api: { bodyParser: false } };

module.exports = handler;
