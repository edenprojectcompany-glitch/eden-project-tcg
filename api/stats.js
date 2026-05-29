// api/stats.js — Stats publiques : jackpot, compteur commandes (cache 5min)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { kv } = require('@vercel/kv');
    const jackpot = (await kv.get('jackpot:pool')) || 0;
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ jackpot: +jackpot });
  } catch {
    return res.status(200).json({ jackpot: 0 });
  }
};
