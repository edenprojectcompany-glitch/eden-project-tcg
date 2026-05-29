// api/capture-paypal-order.js — Capture PayPal après approbation utilisateur
// Env requis : PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV, SITE_URL

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'live';
const PAYPAL_BASE = PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

    console.log(`PayPal captured: order=${data.id} capture=${captureId} amount=${amount}`);
    return res.status(200).json({ ok: true, orderId: data.id, captureId, amount });
  } catch (err) {
    console.error('PayPal capture error:', err.message);
    return res.status(500).json({ error: 'Erreur lors de la capture du paiement' });
  }
};
