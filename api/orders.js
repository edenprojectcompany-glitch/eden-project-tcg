// api/orders.js — Gestion globale des commandes (lecture + mise à jour statut)
// Env requis : ADMIN_CODE, KV_REST_API_URL, KV_REST_API_TOKEN

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const MAX_ORDERS = 300;
const VALID_STATUSES = ['pending', 'label_printed', 'shipped'];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const code = req.headers['x-admin-code'];
  if (!code || code !== process.env.ADMIN_CODE) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    const { kv } = require('@vercel/kv');

    // ── GET : retourne toutes les commandes ──
    if (req.method === 'GET') {
      const orders = await kv.get('orders:global') || [];
      return res.status(200).json({ orders });
    }

    // ── POST : actions admin ──
    if (req.method === 'POST') {
      const { action, ref, status } = req.body || {};

      if (action === 'update_status') {
        if (!ref || typeof ref !== 'string' || ref.length > 20) {
          return res.status(400).json({ error: 'Référence invalide' });
        }
        if (!VALID_STATUSES.includes(status)) {
          return res.status(400).json({ error: 'Statut invalide' });
        }
        const orders = await kv.get('orders:global') || [];
        const idx = orders.findIndex(o => o.ref === ref);
        if (idx === -1) return res.status(404).json({ error: 'Commande introuvable' });
        orders[idx].status = status;
        if (status === 'shipped') orders[idx].shippedAt = new Date().toISOString();
        if (status === 'label_printed') orders[idx].labelPrintedAt = new Date().toISOString();
        await kv.set('orders:global', orders);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Action inconnue' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Orders API error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
