// api/create-paypal-order.js — PayPal Order avec validation prix serveur (prix dégressifs)
// Env requis : PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV, SITE_URL, KV_REST_API_URL, KV_REST_API_TOKEN

const { PAYPAL_BASE, getPayPalToken } = require('../lib/paypal');
const jwt = require('jsonwebtoken');
const { PROMO_CODES, PRIZE_CODES, FIRST_ORDER_CODES, WHEEL_ONLY_CODES, PRODUCT_LANG, getServerPrice, getAutoPromoPct, computeLangPools } = require('../lib/prices');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { items, shippingCost, promoCode, customerEmail } = req.body || {};
    if (!items?.length) return res.status(400).json({ error: 'Panier vide' });
    if (items.length > 50) return res.status(400).json({ error: 'Trop d\'articles' });

    const code = (promoCode || '').toUpperCase();
    const promoCodePct = PROMO_CODES[code] || 0;
    const isShipFree = code === 'SHIP0';
    const isPrizeCode = PRIZE_CODES.has(code);
    const wheelCodeConfig = WHEEL_ONLY_CODES[code];

    // ── Auth JWT obligatoire pour tout achat ──
    const authHeader = (req.headers.authorization || '').replace('Bearer ', '');
    if (!authHeader) {
      return res.status(401).json({ error: 'Connexion requise pour passer commande' });
    }
    let decoded;
    try { decoded = jwt.verify(authHeader, process.env.JWT_SECRET); } catch {
      return res.status(401).json({ error: 'Session expirée — reconnectez-vous' });
    }
    const verifiedUserEmail = decoded.email;

    // 1 seul appel KV — inclut flash sale prices + user + shipping config
    let adminPrices = {};
    let verifiedUser = null;
    let shippingCfg = { relay: 4.90, colissimo: 7.90, express: 14.90, freeForAll: false };
    let kvFailed = false;
    try {
      const { kv } = require('@vercel/kv');
      const [prices, flashsale, userFromKv, shippingFromKv] = await Promise.all([
        kv.get('admin:prices'),
        kv.get('admin:flashsale'),
        kv.get(`user:${verifiedUserEmail}`),
        kv.get('admin:shipping'),
      ]);
      if (shippingFromKv) shippingCfg = shippingFromKv;
      verifiedUser = userFromKv || null;
      // Vérification tokenVersion : rejeter les sessions révoquées (ex: après reset mot de passe)
      if (verifiedUser && verifiedUser.tokenVersion != null && decoded.tokenVersion !== verifiedUser.tokenVersion) {
        return res.status(401).json({ error: 'Session révoquée — reconnectez-vous' });
      }
      adminPrices = prices || {};
      if (flashsale) {
        const now = Date.now();
        for (const [id, fs] of Object.entries(flashsale)) {
          if (fs.active && fs.salePrice != null && (!fs.endTime || fs.endTime > now)) {
            adminPrices[id] = +parseFloat(fs.salePrice).toFixed(2);
          }
        }
      }
    } catch (e) {
      kvFailed = true;
      console.error('[create-paypal-order] KV load failed:', e.message);
    }

    // Validation livraison côté serveur (valeurs dynamiques depuis KV)
    const parsedShip = +(parseFloat(shippingCost || 0).toFixed(2));
    const isFreeForAll = !!shippingCfg.freeForAll;
    const validShipping = isFreeForAll
      ? [0]
      : [0, shippingCfg.relay, shippingCfg.colissimo, shippingCfg.express];
    if (!validShipping.some(v => Math.abs(v - parsedShip) < 0.01)) {
      return res.status(400).json({ error: 'Frais de livraison invalides' });
    }
    if (parsedShip === 0 && !isShipFree && !isFreeForAll) {
      return res.status(400).json({ error: 'Code promo livraison requis' });
    }
    const shipping = parsedShip;

    // ── Codes première commande (WELCOME10, WELCOME5) ──
    if (FIRST_ORDER_CODES.has(code)) {
      if (kvFailed) {
        return res.status(503).json({ error: 'Service temporairement indisponible, réessayez dans quelques secondes' });
      }
      const existingOrders = Array.isArray(verifiedUser?.orders) ? verifiedUser.orders.length : 0;
      if (existingOrders > 0) {
        return res.status(403).json({ error: `Le code ${code} est réservé à votre première commande` });
      }
    }

    // Palier groupé par langue
    const langPools = computeLangPools(items.map(i => ({ id: i.id, qty: parseInt(i.qty) || 0 })));

    // Passe 1 : sous-total brut pour auto-promo
    let rawSubtotal = 0;
    const rawItems = [];
    for (const item of items) {
      const qty = parseInt(item.qty);
      if (item.id == null || !qty || qty < 1 || qty > 1000) continue;
      const lang = PRODUCT_LANG[item.id];
      const pooledQty = lang && langPools[lang] ? langPools[lang] : qty;
      const serverPrice = getServerPrice(item.id, qty, adminPrices, pooledQty);
      if (serverPrice === null) continue;
      rawSubtotal += serverPrice * qty;
      rawItems.push({ item, qty, serverPrice });
    }
    if (!rawItems.length) return res.status(400).json({ error: 'Aucun article valide' });

    // Validation code roue
    let wonCodeIndex = -1;
    if (wheelCodeConfig) {
      if (!verifiedUser) return res.status(401).json({ error: 'Utilisateur introuvable' });
      const now = Date.now();
      wonCodeIndex = (verifiedUser.wonCodes || []).findIndex(w =>
        w.code === code && !w.used &&
        (!w.reserved || now - new Date(w.reservedAt || 0).getTime() > 2 * 60 * 60 * 1000)
      );
      if (wonCodeIndex === -1) {
        return res.status(403).json({ error: `Code ${code} invalide — gagné via la roue uniquement et utilisable une seule fois` });
      }
      if (wheelCodeConfig.minAmount > 0 && rawSubtotal < wheelCodeConfig.minAmount) {
        return res.status(400).json({ error: `Code ${code} utilisable à partir de ${wheelCodeConfig.minAmount}€ d'achat` });
      }
    }

    // Remise effective
    const discountPct = promoCodePct || (!isPrizeCode ? getAutoPromoPct(rawSubtotal) : 0);

    // Passe 2 : items validés avec remise
    const validatedItems = rawItems.map(({ item, qty, serverPrice }) => ({
      id: item.id,
      name: String(item.name || '').slice(0, 127),
      qty,
      unitPrice: +(serverPrice * (1 - discountPct / 100)).toFixed(2),
    }));

    const itemTotal = +validatedItems.reduce((s, i) => s + i.unitPrice * i.qty, 0).toFixed(2);
    const total = +(itemTotal + shipping).toFixed(2);

    const token = await getPayPalToken();
    const paypalRequestId = `eden-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const order = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': paypalRequestId,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: `EDN-${Date.now()}`,
          custom_id: verifiedUserEmail.slice(0, 127),
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
    if (!orderData.id) {
      const reason = orderData.details?.[0]?.description || orderData.message || 'PayPal order failed';
      throw new Error(reason);
    }

    // Stocker les items + infos dans KV pour récupération à la capture (TTL 24h)
    try {
      const { kv } = require('@vercel/kv');
      const pending = {
        items: validatedItems.map(i => ({ n: i.name, q: i.qty, p: i.unitPrice })),
        promoCode: code,
        userEmail: verifiedUserEmail || '',
        wonCodeIndex,
      };
      await kv.set(`paypal:order:${orderData.id}`, pending, { ex: 86400 });

      // Réserver le code roue
      if (wheelCodeConfig && wonCodeIndex !== -1 && verifiedUserEmail) {
        const freshUser = await kv.get(`user:${verifiedUserEmail}`);
        if (freshUser && freshUser.wonCodes && freshUser.wonCodes[wonCodeIndex]) {
          freshUser.wonCodes[wonCodeIndex].reserved = true;
          freshUser.wonCodes[wonCodeIndex].reservedAt = new Date().toISOString();
          await kv.set(`user:${verifiedUserEmail}`, freshUser);
        }
      }
    } catch {}

    const approveUrl = orderData.links?.find(l => l.rel === 'approve')?.href;
    return res.status(200).json({ orderId: orderData.id, approveUrl });
  } catch (err) {
    console.error('PayPal error:', err.message);
    return res.status(500).json({ error: 'Erreur paiement PayPal' });
  }
};
