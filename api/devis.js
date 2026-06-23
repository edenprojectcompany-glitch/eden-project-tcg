// api/devis.js — Gestion des devis clients (admin uniquement)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, ADMIN_CODE

const crypto = require('crypto');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const STATUSES = ['brouillon', 'envoye', 'accepte', 'refuse', 'expire'];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
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

function sanitizeQuote(data) {
  const items = Array.isArray(data.items) ? data.items.slice(0, 50).map(i => ({
    name: String(i.name || '').slice(0, 120),
    qty: Math.max(0, parseFloat(i.qty) || 0),
    unitPrice: Math.max(0, parseFloat(i.unitPrice) || 0),
  })).filter(i => i.name && i.qty > 0) : [];

  return {
    items,
    client: {
      name: String(data.client?.name || '').slice(0, 100),
      email: String(data.client?.email || '').slice(0, 150),
      phone: String(data.client?.phone || '').slice(0, 30),
      company: String(data.client?.company || '').slice(0, 100),
      address: String(data.client?.address || '').slice(0, 300),
    },
    shippingLabel: String(data.shippingLabel || '').slice(0, 80),
    shippingCost: Math.max(0, parseFloat(data.shippingCost) || 0),
    discountType: data.discountType === 'fixed' ? 'fixed' : 'pct',
    discountValue: Math.max(0, parseFloat(data.discountValue) || 0),
    notes: String(data.notes || '').slice(0, 1000),
    validUntil: data.validUntil ? String(data.validUntil).slice(0, 10) : '',
    status: STATUSES.includes(data.status) ? data.status : 'brouillon',
  };
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

    if (req.method === 'GET') {
      const [list, settings] = await Promise.all([
        kv.get('devis:list'),
        kv.get('devis:settings'),
      ]);
      return res.status(200).json({ quotes: list || [], settings: settings || {} });
    }

    if (req.method === 'POST') {
      const { action, data } = req.body || {};

      if (action === 'save_settings') {
        const settings = {
          titulaire: String(data?.titulaire || '').slice(0, 100),
          iban: String(data?.iban || '').slice(0, 40),
          bic: String(data?.bic || '').slice(0, 20),
          banque: String(data?.banque || '').slice(0, 100),
          footerNote: String(data?.footerNote || '').slice(0, 500),
        };
        await kv.set('devis:settings', settings);
        return res.status(200).json({ ok: true, settings });
      }

      if (action === 'save') {
        if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Données invalides' });
        const clean = sanitizeQuote(data);
        if (!clean.items.length) return res.status(400).json({ error: 'Au moins un article requis' });
        if (!clean.client.name) return res.status(400).json({ error: 'Nom du client requis' });

        const list = await kv.get('devis:list') || [];
        const now = new Date().toISOString();
        let quote;

        if (data.id) {
          const idx = list.findIndex(q => q.id === data.id);
          if (idx === -1) return res.status(404).json({ error: 'Devis introuvable' });
          list[idx] = { ...list[idx], ...clean, updatedAt: now };
          quote = list[idx];
        } else {
          const counter = await kv.incr('devis:counter');
          const year = new Date().getFullYear();
          quote = {
            id: crypto.randomBytes(8).toString('hex'),
            ref: `DEV-${year}-${String(counter).padStart(3, '0')}`,
            createdAt: now,
            updatedAt: now,
            ...clean,
          };
          list.unshift(quote);
        }
        await kv.set('devis:list', list);
        return res.status(200).json({ ok: true, quote: { ...quote, ...computeTotals(quote) } });
      }

      if (action === 'delete') {
        const { id } = data || {};
        if (!id) return res.status(400).json({ error: 'id requis' });
        const list = await kv.get('devis:list') || [];
        await kv.set('devis:list', list.filter(q => q.id !== id));
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_status') {
        const { id, status } = data || {};
        if (!id || !STATUSES.includes(status)) {
          return res.status(400).json({ error: 'Données invalides' });
        }
        const list = await kv.get('devis:list') || [];
        const idx = list.findIndex(q => q.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Devis introuvable' });
        list[idx].status = status;
        list[idx].updatedAt = new Date().toISOString();
        await kv.set('devis:list', list);
        return res.status(200).json({ ok: true });
      }

      if (action === 'send_email') {
        const { id } = data || {};
        const list = await kv.get('devis:list') || [];
        const quote = list.find(q => q.id === id);
        if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
        if (!quote.client?.email) return res.status(400).json({ error: 'Email client manquant' });

        const settings = await kv.get('devis:settings') || {};
        const { sendEmail, quoteHtml, SITE_URL } = require('../lib/email');
        const totals = computeTotals(quote);
        const publicUrl = `${SITE_URL}/devis?id=${quote.id}`;
        await sendEmail({
          to: quote.client.email,
          subject: `Votre devis ${quote.ref} — Eden Project TCG`,
          html: quoteHtml({ quote, totals, settings, publicUrl }),
        });

        const idx = list.findIndex(q => q.id === id);
        if (list[idx].status === 'brouillon') list[idx].status = 'envoye';
        list[idx].updatedAt = new Date().toISOString();
        await kv.set('devis:list', list);
        return res.status(200).json({ ok: true, publicUrl });
      }

      return res.status(400).json({ error: 'Action inconnue' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Devis error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
