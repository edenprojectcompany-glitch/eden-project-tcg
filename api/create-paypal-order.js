// api/create-paypal-order.js — PayPal Order avec validation prix serveur (prix dégressifs)
// Env requis : PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV, SITE_URL

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'live';
const PAYPAL_BASE = PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// Même structure de prix avec dégressivité que create-payment.js
const BASE_PRICES = {
  1:{tiers:[{q:10,p:65},{q:20,p:60},{q:60,p:55}]},
  2:{tiers:[{q:10,p:65},{q:20,p:60},{q:60,p:58}]},
  3:{tiers:[{q:10,p:65},{q:20,p:55},{q:60,p:55}]},
  4:{tiers:[{q:10,p:65},{q:20,p:60},{q:60,p:55}]},
  5:{tiers:[{q:10,p:65},{q:20,p:60},{q:60,p:55}]},
  6:{tiers:[{q:10,p:65},{q:20,p:60},{q:60,p:60}]},
  7:{tiers:[{q:10,p:null}]},
  8:{tiers:[{q:10,p:50},{q:20,p:45},{q:60,p:43}]},
  9:{tiers:[{q:10,p:50},{q:20,p:45},{q:60,p:43}]},
  10:{tiers:[{q:10,p:85},{q:20,p:80},{q:60,p:75}]},
  11:{tiers:[{q:6,p:110},{q:12,p:105},{q:36,p:99}]},
  12:{tiers:[{q:6,p:89},{q:12,p:85},{q:36,p:79}]},
  13:{tiers:[{q:6,p:80},{q:12,p:75},{q:36,p:73}]},
  14:{tiers:[{q:6,p:80},{q:12,p:75},{q:36,p:73}]},
  15:{tiers:[{q:10,p:100},{q:20,p:95},{q:60,p:90}]},
  16:{tiers:[{q:6,p:80},{q:12,p:75},{q:36,p:73}]},
  17:{tiers:[{q:6,p:99},{q:12,p:95},{q:36,p:89}]},
  18:{tiers:[{q:6,p:130},{q:12,p:125},{q:36,p:120}]},
  19:{tiers:[{q:6,p:115},{q:12,p:110},{q:36,p:99}]},
  20:{tiers:[{q:6,p:110},{q:12,p:105},{q:36,p:99}]},
  21:{tiers:[{q:1,p:299},{q:12,p:295},{q:36,p:280}]},
  22:{tiers:[{q:1,p:120},{q:12,p:110},{q:36,p:105}]},
};

const PROMO_CODES = { EDEN5: 5, EDEN10: 10, WELCOME5: 5, TCG15: 15, EDEN20: 20 };
const VALID_SHIPPING = [0, 4.90, 7.90, 14.90];

async function getPayPalToken() {
  const creds = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('PayPal auth failed');
  return data.access_token;
}

async function getServerPrice(id, qty) {
  const base = BASE_PRICES[id];
  if (!base) return null;

  try {
    const { kv } = require('@vercel/kv');
    const prices = await kv.get('admin:prices');
    if (prices && prices[id] != null) return prices[id];
  } catch {}

  if (base.tiers) {
    let price = base.tiers[0].p;
    for (const t of base.tiers) if (qty >= t.q && t.p !== null) price = t.p;
    return price;
  }
  return null;
}

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

    // Validation livraison côté serveur
    const parsedShip = +(parseFloat(shippingCost).toFixed(2));
    if (!VALID_SHIPPING.some(v => Math.abs(v - parsedShip) < 0.01)) {
      return res.status(400).json({ error: 'Frais de livraison invalides' });
    }
    if (parsedShip === 0 && !isShipFree) {
      return res.status(400).json({ error: 'Code promo livraison requis' });
    }
    const shipping = parsedShip;

    // Validation prix avec dégressivité
    const validatedItems = [];
    for (const item of items) {
      const qty = parseInt(item.qty);
      if (!item.id || !qty || qty < 1 || qty > 1000) continue;
      const serverPrice = await getServerPrice(item.id, qty);
      if (serverPrice === null) continue;
      const unitPrice = +(serverPrice * (1 - discountPct / 100)).toFixed(2);
      validatedItems.push({ ...item, qty, unitPrice });
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
        'PayPal-Request-Id': `eden-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: `EDN-${Date.now()}`,
          description: 'Eden Project TCG — Commande displays Pokémon',
          amount: {
            currency_code: 'EUR',
            value: total.toFixed(2),
            breakdown: {
              item_total: { currency_code: 'EUR', value: itemTotal.toFixed(2) },
              shipping: { currency_code: 'EUR', value: shipping.toFixed(2) },
            },
          },
          items: validatedItems.map(item => ({
            name: item.name.slice(0, 127),
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
