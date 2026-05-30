// api/create-payment.js — Stripe Checkout Session avec validation prix serveur
// Env requis : STRIPE_SECRET_KEY, SITE_URL, KV_REST_API_URL, KV_REST_API_TOKEN

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const jwt = require('jsonwebtoken');
const { PROMO_CODES, PRIZE_CODES, FIRST_ORDER_CODES, WHEEL_ONLY_CODES, VALID_SHIPPING, getServerPrice, getAutoPromoPct, computeLangPools } = require('../lib/prices');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IMG_BASE = 'https://raw.githubusercontent.com/edenprojectcompany-glitch/catalogue-pokemon/main/img/';

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

    // Validation livraison côté serveur
    const parsedShip = +(parseFloat(shippingCost || 0).toFixed(2));
    if (!VALID_SHIPPING.some(v => Math.abs(v - parsedShip) < 0.01)) {
      return res.status(400).json({ error: 'Frais de livraison invalides' });
    }
    if (parsedShip === 0 && !isShipFree) {
      return res.status(400).json({ error: 'Code promo livraison requis' });
    }
    const ship = parsedShip;

    // 1 seul appel KV — inclut flash sale prices + user
    let adminPrices = {};
    let verifiedUser = null;
    try {
      const { kv } = require('@vercel/kv');
      const [prices, flashsale, userFromKv] = await Promise.all([
        kv.get('admin:prices'),
        kv.get('admin:flashsale'),
        kv.get(`user:${verifiedUserEmail}`),
      ]);
      verifiedUser = userFromKv || null;
      adminPrices = prices || {};
      // Appliquer les prix flash actifs (priorité sur admin:prices)
      if (flashsale) {
        const now = Date.now();
        for (const [id, fs] of Object.entries(flashsale)) {
          if (fs.active && fs.salePrice != null && (!fs.endTime || fs.endTime > now)) {
            adminPrices[id] = +parseFloat(fs.salePrice).toFixed(2);
          }
        }
      }
    } catch {}

    // ── Codes première commande (WELCOME10, WELCOME5) ──
    if (FIRST_ORDER_CODES.has(code)) {
      const existingOrders = verifiedUser?.orders?.length || 0;
      if (existingOrders > 0) {
        return res.status(403).json({ error: `Le code ${code} est réservé à votre première commande` });
      }
    }

    // Palier groupé par langue : les produits CN s'additionnent entre eux, JP entre eux
    const langPools = computeLangPools(items.map(i => ({ id: i.id, qty: parseInt(i.qty) || 0 })));

    // Passe 1 : calcul du sous-total brut (avant remise) pour déterminer l'auto-promo
    let rawSubtotal = 0;
    const rawItems = [];
    for (const item of items) {
      const qty = parseInt(item.qty);
      if (item.id == null || !qty || qty < 1 || qty > 1000) continue;
      const { PRODUCT_LANG } = require('../lib/prices');
      const lang = PRODUCT_LANG[item.id];
      const pooledQty = lang && langPools[lang] ? langPools[lang] : qty;
      const serverPrice = getServerPrice(item.id, qty, adminPrices, pooledQty);
      if (serverPrice === null) continue;
      rawSubtotal += serverPrice * qty;
      rawItems.push({ item, qty, serverPrice, pooledQty });
    }
    if (!rawItems.length) return res.status(400).json({ error: 'Aucun article valide' });

    // Validation code roue : vérifier wonCodes dans KV
    let wonCodeIndex = -1;
    if (wheelCodeConfig) {
      if (!verifiedUser) return res.status(401).json({ error: 'Utilisateur introuvable' });
      const wonCodes = verifiedUser.wonCodes || [];
      const now = Date.now();
      wonCodeIndex = wonCodes.findIndex(w =>
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

    // Remise effective : code promo prioritaire, sinon auto-promo sur le sous-total
    const discountPct = promoCodePct || (!isPrizeCode ? getAutoPromoPct(rawSubtotal) : 0);

    // Réserver le code roue avant de créer la session (anti double-usage)
    if (wheelCodeConfig && wonCodeIndex !== -1 && verifiedUserEmail) {
      try {
        const { kv } = require('@vercel/kv');
        const freshUser = await kv.get(`user:${verifiedUserEmail}`);
        if (freshUser && freshUser.wonCodes && freshUser.wonCodes[wonCodeIndex]) {
          freshUser.wonCodes[wonCodeIndex].reserved = true;
          freshUser.wonCodes[wonCodeIndex].reservedAt = new Date().toISOString();
          await kv.set(`user:${verifiedUserEmail}`, freshUser);
        }
      } catch {}
    }

    // Passe 2 : construction des line items avec remise effective
    const lineItems = [];
    const itemsSummary = [];
    for (const { item, qty, serverPrice } of rawItems) {
      const finalPrice = Math.round(serverPrice * (1 - discountPct / 100) * 100);
      const productData = {
        name: String(item.name || '').slice(0, 255),
        description: String(item.sub || '').slice(0, 255),
      };
      if (item.img) productData.images = [`${IMG_BASE}${item.img}`];
      lineItems.push({
        price_data: { currency: 'eur', product_data: productData, unit_amount: finalPrice },
        quantity: qty,
      });
      itemsSummary.push({ n: String(item.name || '').slice(0, 40), q: qty, p: +(serverPrice * (1 - discountPct / 100)).toFixed(2) });
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

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: verifiedUserEmail,
      success_url: successUrl || `${CORS_ORIGIN}?payment=success`,
      cancel_url: cancelUrl || `${CORS_ORIGIN}?payment=cancel`,
      metadata: {
        promoCode: code,
        prizeCode: isPrizeCode ? code : '',
        discountPct: String(discountPct),
        source: 'eden-project-tcg',
        items_json: JSON.stringify(itemsSummary.slice(0, 8).map(i => ({ n: i.n.slice(0, 20), q: i.q, p: i.p }))),
        userEmail: verifiedUserEmail || '',
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
