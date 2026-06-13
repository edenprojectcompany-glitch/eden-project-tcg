// api/ebay-prices.js — Prix eBay live avec cache Vercel KV (1h TTL natif)
// Env requis : EBAY_APP_ID, EBAY_CERT_ID, KV_REST_API_URL, KV_REST_API_TOKEN, SITE_URL

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const CACHE_TTL_SECONDS = 3600; // 1h — TTL natif Upstash

async function getEbayToken() {
  const creds = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('eBay auth failed');
  return data.access_token;
}

async function fetchEbayPrice(token, query, kv) {
  const cacheKey = `ebay:${query.toLowerCase().replace(/\s+/g, '_').slice(0, 80)}`;

  try {
    const cached = await kv.get(cacheKey);
    if (cached != null) return cached; // TTL géré nativement par Upstash
  } catch {}

  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
  url.searchParams.set('q', query);
  url.searchParams.set('filter', 'categoryIds:{183454},conditions:{NEW}');
  url.searchParams.set('sort', 'price');
  url.searchParams.set('limit', '10');

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_FR',
    },
  });
  const data = await res.json();

  if (!data.itemSummaries?.length) return null;

  const prices = data.itemSummaries
    .slice(0, 5)
    .map(i => parseFloat(i.price?.value))
    .filter(p => !isNaN(p) && p > 0);

  if (!prices.length) return null;
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

  try {
    // TTL natif — la valeur expire automatiquement dans Upstash
    await kv.set(cacheKey, avg, { ex: CACHE_TTL_SECONDS });
  } catch {}

  return avg;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { queries } = req.body || {};
  if (!queries?.length) return res.status(400).json({ error: 'queries required' });
  if (queries.length > 30) return res.status(400).json({ error: 'Maximum 30 requêtes simultanées' });

  try {
    const { kv } = require('@vercel/kv');
    const token = await getEbayToken();
    const results = await Promise.all(
      queries.map(async ({ id, term }) => ({
        id,
        price: term ? await fetchEbayPrice(token, String(term).slice(0, 200), kv) : null,
      }))
    );
    return res.status(200).json({ prices: Object.fromEntries(results.map(r => [r.id, r.price])) });
  } catch (err) {
    console.error('eBay error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur eBay' });
  }
};
