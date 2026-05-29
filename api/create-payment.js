// api/create-payment.js — Stripe Checkout Session avec validation prix serveur
// Env requis : STRIPE_SECRET_KEY, SITE_URL, KV_REST_API_URL, KV_REST_API_TOKEN

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { PROMO_CODES, PRIZE_CODES, VALID_SHIPPING, getServerPrice, getAutoPromoPct } = require('../lib/prices');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { items, shippingCost, promoCode, customerEmail, successUrl, cancelUrl } = req.body || {};
    if (!items?.length) return res.status(400).json({ error: 'Panier vide' });
    if (items.length > 50) return res.status(400).json({ error: 'Trop d\'articles' });

    const code = (promoCode || '').toUpperCase();
    const promoCodePct = PROMO_CODES[code] || 0;
    const isShipFree = code === 'SHIP0';
    const isPrizeCode = PRIZE_CODES.has(code);

    // Validation livraison côté serveur
    const parsedShip = +(parseFloat(shippingCost || 0).toFixed(2));
    if (!VALID_SHIPPING.some(v => Math.abs(v - parsedShip) < 0.01)) {
      return res.status(400).json({ error: 'Frais de livraison invalides' });
    }
    if (parsedShip === 0 && !isShipFree) {
      return res.status(400).json({ error: 'Code promo livraison requis' });
    }
    const ship = parsedShip;

    // 1 seul appel KV avant la boucle (fix N+1)
    let adminPrices = {};
    try {
      const { kv } = require('@vercel/kv');
      adminPrices = await kv.get('admin:prices') || {};
    } catch {}

    // Passe 1 : calcul du sous-total brut (avant remise) pour déterminer l'auto-promo
    let rawSubtotal = 0;
    const rawItems = [];
    for (const item of items) {
      const qty = parseInt(item.qty);
      if (!item.id || !qty || qty < 1 || qty > 1000) continue;
      const serverPrice = getServerPrice(item.id, qty, adminPrices);
      if (serverPrice === null) continue;
      rawSubtotal += serverPrice * qty;
      rawItems.push({ item, qty, serverPrice });
    }
    if (!rawItems.length) return res.status(400).json({ error: 'Aucun article valide' });

    // Remise effective : code promo prioritaire, sinon auto-promo sur le sous-total
    const discountPct = promoCodePct || (!isPrizeCode ? getAutoPromoPct(rawSubtotal) : 0);

    // Passe 2 : construction des line items avec remise effective
    const lineItems = [];
    for (const { item, qty, serverPrice } of rawItems) {
      const finalPrice = Math.round(serverPrice * (1 - discountPct / 100) * 100);
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: String(item.name || '').slice(0, 255),
            description: String(item.sub || '').slice(0, 255),
          },
          unit_amount: finalPrice,
        },
        quantity: qty,
      });
    }
    if (!lineItems.length) return res.status(400).json({ error: 'Aucun article valide' });

    if (ship > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: 'Livraison' },
          unit_amount: Math.round(ship * 100),
        },
        quantity: 1,
      });
    }

    const validEmail = customerEmail && EMAIL_RE.test(customerEmail) ? customerEmail : undefined;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: validEmail,
      success_url: successUrl || `${CORS_ORIGIN}?payment=success`,
      cancel_url: cancelUrl || `${CORS_ORIGIN}?payment=cancel`,
      metadata: {
        promoCode: code,
        prizeCode: isPrizeCode ? code : '',
        discountPct: String(discountPct),
        source: 'eden-project-tcg',
      },
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'CH', 'LU', 'MC'] },
      locale: 'fr',
    });

    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: 'Erreur lors de la création du paiement' });
  }
};
