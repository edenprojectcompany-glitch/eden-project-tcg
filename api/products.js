// api/products.js — Retourne les overrides prix/stock depuis Vercel KV
// Utilisé par le front pour merger avec le catalogue statique
// Cache 60s côté Vercel edge

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { kv } = require('@vercel/kv');
    const [prices, stocks, flashsale, shipping, graded] = await Promise.all([
      kv.get('admin:prices'),
      kv.get('admin:stocks'),
      kv.get('admin:flashsale'),
      kv.get('admin:shipping'),
      kv.get('admin:graded'),
    ]);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      prices: prices || {},
      stocks: stocks || {},
      flashsale: flashsale || {},
      shipping: shipping || { relay: 4.90, colissimo: 7.90, express: 14.90 },
      graded: graded || null,
    });
  } catch {
    return res.status(200).json({
      prices: {}, stocks: {}, flashsale: {},
      shipping: { relay: 4.90, colissimo: 7.90, express: 14.90 },
      graded: null,
    });
  }
};
