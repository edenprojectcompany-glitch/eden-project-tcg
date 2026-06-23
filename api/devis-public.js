// api/devis-public.js — Lecture publique d'un devis (lien envoyé au client, sans authentification)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function computeTotals(q) {
  const subtotal = (q.items || []).reduce((s, i) => s + (parseFloat(i.qty) || 0) * (parseFloat(i.unitPrice) || 0), 0);
  const discount = q.discountType === 'pct'
    ? subtotal * (parseFloat(q.discountValue) || 0) / 100
    : (parseFloat(q.discountValue) || 0);
  const shipping = parseFloat(q.shippingCost) || 0;
  const total = Math.max(0, subtotal - discount) + shipping;
  return { subtotal: +subtotal.toFixed(2), discount: +discount.toFixed(2), shipping: +shipping.toFixed(2), total: +total.toFixed(2) };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const id = String(req.query.id || '').trim();
  if (!/^[a-f0-9]{8,32}$/i.test(id)) return res.status(400).json({ error: 'Identifiant invalide' });

  try {
    const { kv } = require('@vercel/kv');
    const [list, settings] = await Promise.all([
      kv.get('devis:list'),
      kv.get('devis:settings'),
    ]);
    const quote = (list || []).find(q => q.id === id);
    if (!quote) return res.status(404).json({ error: 'Devis introuvable' });

    return res.status(200).json({
      quote: {
        ref: quote.ref,
        createdAt: quote.createdAt,
        validUntil: quote.validUntil,
        status: quote.status,
        client: quote.client,
        items: quote.items,
        shippingLabel: quote.shippingLabel,
        shippingCost: quote.shippingCost,
        discountType: quote.discountType,
        discountValue: quote.discountValue,
        notes: quote.notes,
      },
      totals: computeTotals(quote),
      settings: {
        titulaire: (settings || {}).titulaire || '',
        iban: (settings || {}).iban || '',
        bic: (settings || {}).bic || '',
        banque: (settings || {}).banque || '',
        footerNote: (settings || {}).footerNote || '',
      },
    });
  } catch (err) {
    console.error('Devis public error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
