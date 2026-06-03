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

      // Récupérer les items depuis les metadata (stockés à la création de session)
      let orderItems = [];
      try {
        const rawItems = session.metadata?.items_json;
        if (rawItems) orderItems = JSON.parse(rawItems);
      } catch {}

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
        items: orderItems,
      };

      // Jackpot progressif : 1€ par commande alimente le pool (incrbyfloat = atomique)
      try {
        await kv.incrbyfloat('jackpot:pool', 1);
      } catch {}

      // ── Opérations KV critiques (échec → 500 pour que Stripe retente) ──
      if (email) {
        const key = `user:${email.toLowerCase().trim()}`;
        const user = await kv.get(key);
        if (user) {
          user.orders = user.orders || [];
          user.orders.unshift(order);
          const pts = Math.floor(parseFloat(order.amount));
          user.loyalty = (user.loyalty || 0) + pts;

          // Marquer le code comme utilisé (tous types : wheel-only, discount, etc.)
          const promoCode = session.metadata?.promoCode || '';
          if (promoCode && user.wonCodes) {
            const idx = user.wonCodes.findIndex(w => w.code === promoCode && !w.used);
            if (idx !== -1) { user.wonCodes[idx].used = true; user.wonCodes[idx].usedAt = new Date().toISOString(); }
          }

          await kv.set(key, user); // ← si ça lève, le catch externe retourne 500
          console.log(`Order ${order.ref} saved for ${email} (+${pts} pts loyalty)`);
        }

        // ── Push dans la liste globale des commandes (dashboard admin) ──
        try {
          let mrPoint = null;
          try { if (session.metadata?.mrPoint) mrPoint = JSON.parse(session.metadata.mrPoint); } catch {}
          const globalOrders = await kv.get('orders:global') || [];
          // Adresse de livraison : d'abord notre formulaire (coAddr), sinon Stripe shipping_details
          let shippingAddress = null;
          try {
            const coAddr = session.metadata?.coAddr;
            if (coAddr) {
              const a = JSON.parse(coAddr);
              shippingAddress = {
                name:        a.name        || customerName,
                line1:       a.line1       || '',
                line2:       a.line2       || '',
                city:        a.city        || '',
                postal_code: a.postal_code || '',
                country:     a.country     || 'FR',
              };
            }
          } catch {}
          // Fallback : Stripe shipping_details (si disponible)
          if (!shippingAddress && session.shipping_details?.address) {
            const sd = session.shipping_details;
            shippingAddress = {
              name:        sd.name || customerName,
              line1:       sd.address.line1 || '',
              line2:       sd.address.line2 || '',
              city:        sd.address.city || '',
              postal_code: sd.address.postal_code || '',
              country:     sd.address.country || 'FR',
            };
          }
          globalOrders.unshift({
            ref: order.ref,
            customerEmail: email || '',
            customerName: customerName,
            amount: order.amount,
            provider: 'stripe',
            items: orderItems,
            shippingMode: session.metadata?.shippingMode || '',
            shippingAddress,
            mrPoint,
            status: 'pending',
            createdAt: order.createdAt,
          });
          if (globalOrders.length > 300) globalOrders.splice(300);
          await kv.set('orders:global', globalOrders);
        } catch (e) {
          console.error('orders:global push failed (non-critical):', e.message);
        }
      }

    } catch (err) {
      // Erreur KV critique : retourner 500 pour que Stripe retente le webhook
      console.error('Webhook KV failed (Stripe retrying):', err.message);
      return res.status(500).json({ error: 'Internal error — will retry' });
    }

    // ── Emails non-critiques (échec → log uniquement, on retourne 200) ──
    const emailAddr = session.customer_email || session.customer_details?.email;
    const custName = session.customer_details?.name || '';
    const ref = `EDN-${session.id.slice(-6).toUpperCase()}`;
    const amount = (session.amount_total / 100).toFixed(2);
    let emailItems = [];
    try { emailItems = JSON.parse(session.metadata?.items_json || '[]'); } catch {}

    try {
      if (emailAddr) {
        await sendEmail({
          to: emailAddr,
          subject: `✅ Commande confirmée ${ref} — Eden Project TCG`,
          html: orderConfirmationHtml({ ref, name: custName, amount, items: emailItems, provider: 'stripe' }),
        });
      }
      await sendEmail({
        to: ADMIN_EMAIL,
        subject: `🛒 Nouvelle commande Stripe ${ref} — ${amount}€`,
        html: adminOrderHtml({
          ref, customerEmail: emailAddr, customerName: custName, amount, provider: 'stripe',
          promoCode: session.metadata?.promoCode || '',
          prizeCode: session.metadata?.prizeCode || '',
        }),
      });
    } catch (emailErr) {
      console.error('Webhook email failed (non-critical):', emailErr.message);
    }
  }

  return res.status(200).json({ received: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
