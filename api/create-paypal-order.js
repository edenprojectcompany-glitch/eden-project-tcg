// api/create-paypal-order.js — PayPal Order avec validation prix serveur (prix dégressifs)
// Env requis : PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV, SITE_URL, KV_REST_API_URL, KV_REST_API_TOKEN

const { PAYPAL_BASE, getPayPalToken } = require('../lib/paypal');
const { PROMO_CODES, PRIZE_CODES, VALID_SHIPPING, getServerPrice } = require('../lib/prices');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { items, shippingCost, promoCode } = req.body || {};
    if (!items?.length) return res.status(400).json({ error: 'Panier vide' });
    if (items.length > 50) return res.status(400).json({ error: 'Trop d\'articles' });

    const code = (promoCode || '').toUpperCase();
    const discountPct = PROMO_CODES[code] || 0;
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
    const shipping = parsedShip;

    // 1 seul appel KV avant la boucle (fix N+1)
    let adminPrices = {};
    try {
      const { kv } = require('@vercel/kv');
      adminPrices = await kv.get('admin:prices') || {};
    } catch {}

    // Validation prix avec dégressivité
    const validatedItems = [];
    for (const item of items) {
      const qty = parseInt(item.qty);
      if (!item.id || !qty || qty < 1 || qty > 1000) continue;
      const serverPrice = getServerPrice(item.id, qty, adminPrices);
      if (serverPrice === null) continue;
      const unitPrice = +(serverPrice * (1 - discountPct / 100)).toFixed(2);
      validatedItems.push({
        id: item.id,
        name: String(item.name || '').slice(0, 127),  // fix C1 : String() avant slice
        qty,
        unitPrice,
      });
    }
    if (!validatedItems.length) return res.status(400).json({ error: 'Aucun article valide' });

    const itemTotal = +validatedItems.reduce((s, i) => s + i.unitPrice * i.qty, 0).toFixed(2);
    const total = +(itemTotal + shipping).toFixed(2);

    const token = await getPayPalToken();
    const order = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `eden-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: `EDN-${Date.now()}`,
          description: isPrizeCode
            ? `Eden Project TCG — Prix roue : ${code}`
            : 'Eden Project TCG — Commande displays Pokémon',
          amount: {
            currency_code: 'EUR',
            value: total.toFixed(2),
            breakdown: {
              item_total: { currency_code: 'EUR', value: itemTotal.toFixed(2) },
              shipping: { currency_code: 'EUR', value: shipping.toFixed(2) },
            },
          },
          items: validatedItems.map(item => ({
            name: item.name,
            unit_amount: { currency_code: 'EUR', value: item.unitPrice.toFixed(2) },
            quantity: String(item.qty),
            category: 'PHYSICAL_GOODS',
          })),
        }],
        application_context: {
          brand_name: 'Eden Project TCG',
          locale: 'fr-FR',
          landing_page: 'NO_PREFERENCE',
          shipping_preference: 'GET_FROM_FILE',
          user_action: 'PAY_NOW',
          return_url: `${CORS_ORIGIN}?payment=success`,
          cancel_url: `${CORS_ORIGIN}?payment=cancel`,
        },
      }),
    });

    const orderData = await order.json();
    if (!orderData.id || orderData.name) {
      const reason = orderData.details?.[0]?.description || orderData.message || 'PayPal order failed';
      throw new Error(reason);
    }

    const approveUrl = orderData.links?.find(l => l.rel === 'approve')?.href;
    return res.status(200).json({ orderId: orderData.id, approveUrl });
  } catch (err) {
    console.error('PayPal error:', err.message);
    return res.status(500).json({ error: 'Erreur paiement PayPal' });
  }
};
