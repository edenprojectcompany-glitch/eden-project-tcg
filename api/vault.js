// api/vault.js — Eden Vault intégré au site : packs mystère payés en euros (Stripe),
// ouverture en 3D sur /vault, cartes tirées dans le stock « Cartes Vault » de l'admin.
// Tant que le Vault n'est pas ouvert au public (admin), seul le code admin y donne accès.
// Env requis : JWT_SECRET, ADMIN_CODE, STRIPE_SECRET_KEY, SITE_URL, KV_REST_API_URL, KV_REST_API_TOKEN
//
// GET  ?q=config                         → packs, cartes et chances (ou {closed:true})
// POST {action:'state'}                  → packs à ouvrir + coffre du joueur
// POST {action:'buy', boxId, count}      → session Stripe (les packs sont crédités par le webhook)
// POST {action:'open', boxId, count}     → ouvre des packs déjà payés
// POST {action:'rotate_seed', clientSeed}→ révèle la graine serveur (tirage vérifiable)
// POST {action:'admin_grant', email, boxId, count} / {action:'admin_open', open} / {action:'admin_info'} (code admin)

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { packOdds, pickCard } = require('../lib/vault-odds');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const SITE = process.env.SITE_URL || 'https://www.edenprojecttcg.com';
const MAX_OPEN = 10;
// Les deux boosters mystère : illustration animée sur le sachet, nom et prix par défaut
// (le nom et le prix réels viennent du calculateur de l'admin dès qu'un réglage est enregistré)
const PACK_INFO = {
  ar: { name: 'Mystère AR', price: 9.9, tagline: '1 carte Art Rare garantie', theme: ['#ffd97f', '#c9a8ff'], art: '/image/vault3d/mew-sm.jpg', artKind: 'flames' },
  ex: { name: 'Mystère EX', price: 4.9, tagline: '1 carte ex garantie', theme: ['#7fd9ff', '#b98aff'], art: '/image/vault3d/pack-dracaufeu.jpg', artKind: 'sky' },
};

const K = {
  open: 'vault:open', cards: 'vault:cards', packs: 'vault:packs', lock: 'vault:lock:stock',
  credits: uid => `vault:credits:${uid}`, inv: uid => `vault:inv:${uid}`, history: uid => `vault:history:${uid}`,
  seed: uid => `vault:seed:${uid}`, nonce: uid => `vault:nonce:${uid}`, feed: 'vault:feed',
};

class HttpError extends Error { constructor(status, msg, data) { super(msg); this.status = status; this.data = data; } }
const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const round2 = n => Math.round(n * 100) / 100;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Code');
}
const isAdmin = req => { const c = req.headers['x-admin-code']; return !!c && !!process.env.ADMIN_CODE && c === process.env.ADMIN_CODE; };

// Compte du site (même connexion que la boutique)
async function getUser(kv, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) throw new HttpError(401, 'Connecte-toi pour continuer');
  let d;
  try { d = jwt.verify(token, process.env.JWT_SECRET); } catch { throw new HttpError(401, 'Session expirée, reconnecte-toi'); }
  const user = await kv.get(`user:${d.email}`);
  if (!user) throw new HttpError(401, 'Compte introuvable');
  if (user.tokenVersion != null && d.tokenVersion !== user.tokenVersion) throw new HttpError(401, 'Session expirée, reconnecte-toi');
  return { id: user.id, email: user.email, name: user.name };
}

// ── Provably fair : HMAC(serverSeed, clientSeed:nonce) ─────────
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const newSeed = n => crypto.randomBytes(n).toString('hex');
const rollFrom = (server, client, nonce) => parseInt(crypto.createHmac('sha256', server).update(`${client}:${nonce}`).digest('hex').slice(0, 13), 16) / 2 ** 52;
async function getSeeds(kv, uid) {
  let s = parse(await kv.get(K.seed(uid)));
  if (!s) { s = { server: newSeed(32), client: newSeed(8) }; await kv.set(K.seed(uid), JSON.stringify(s)); }
  return s;
}
async function nextRoll(kv, uid) {
  const s = await getSeeds(kv, uid);
  const nonce = await kv.incr(K.nonce(uid));
  return { roll: rollFrom(s.server, s.client, nonce), nonce, clientSeed: s.client, serverHash: sha256(s.server) };
}

// ── Catalogue : packs réglés dans l'admin + cartes en stock ───
// Les deux boosters sont toujours présentés ; sans réglage ou sans stock, ils sont « bientôt disponibles »
async function catalog(kv) {
  const [stock, packs] = await Promise.all([kv.get(K.cards), kv.get(K.packs)]);
  const items = {}, boxes = [];
  for (const id of ['ar', 'ex']) {
    const info = PACK_INFO[id], p = (packs && packs[id]) || {};
    const odds = p.price > 0 ? packOdds(stock || [], p) : { ok: false, rows: [], ev: 0 };
    const rows = odds.ok ? odds.rows : [];
    for (const c of rows) items[c.cardId] = {
      id: c.cardId, kind: 'card', name: c.nameFr ? `${c.nameFr} · ${c.rarity}` : c.name, nameJa: c.name, short: c.nameFr || c.name,
      img: playImg(c.img), value: c.value, rarity: c.rarity, set: c.set, number: c.number, total: c.total, intlPreview: !!c.intlPreview,
    };
    boxes.push({
      id, name: p.name || info.name, tagline: info.tagline, price: p.price > 0 ? p.price : info.price, theme: info.theme,
      art: info.art, artKind: info.artKind, available: rows.length > 0,
      ev: round2(odds.ev || 0), table: rows.map(c => ({ itemId: c.cardId, p: c.p, tier: c.lot, qty: c.qty })),
      _odds: odds, _pack: p,
    });
  }
  return { items, boxes, stock: stock || [] };
}
// Images officielles servies par notre relais (utilisables en texture 3D)
const playImg = img => /^https:\/\/www\.pokemon-card\.com\//.test(img || '') ? '/api/cards?src=' + encodeURIComponent(img) : img;
const publicBoxes =boxes => boxes.map(({ _odds, _pack, ...b }) => ({ ...b, table: b.table.map(({ qty, ...r }) => r) }));

async function state(kv, user) {
  const [credits, inv] = await Promise.all([kv.hgetall(K.credits(user.id)), kv.hgetall(K.inv(user.id))]);
  const seeds = await getSeeds(kv, user.id);
  const nonce = Number(await kv.get(K.nonce(user.id))) || 0;
  return {
    user: { name: user.name },
    credits: Object.fromEntries(Object.entries(credits || {}).map(([k, v]) => [k, Number(v) || 0]).filter(([, v]) => v > 0)),
    inventory: Object.values(inv || {}).map(parse).filter(Boolean).sort((a, b) => b.at - a.at),
    fair: { serverHash: sha256(seeds.server), clientSeed: seeds.client, nonce },
  };
}

// Verrou court sur le stock : deux ouvertures simultanées ne peuvent pas tirer le dernier exemplaire
async function withStockLock(kv, fn) {
  for (let i = 0; i < 40; i++) {
    if (await kv.set(K.lock, '1', { nx: true, ex: 10 })) {
      try { return await fn(); } finally { await kv.del(K.lock); }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new HttpError(503, 'Beaucoup d’ouvertures en même temps, réessaie dans un instant');
}

async function open(kv, user, { boxId, count }) {
  const n = Math.min(MAX_OPEN, Math.max(1, Math.floor(+count || 1)));
  const left = await kv.hincrby(K.credits(user.id), String(boxId), -n);
  if (left < 0) { await kv.hincrby(K.credits(user.id), String(boxId), n); throw new HttpError(402, 'Aucun pack à ouvrir : achète-en d’abord'); }

  const results = await withStockLock(kv, async () => {
    const out = [];
    const packs = (await kv.get(K.packs)) || {};
    const pack = packs[boxId];
    let stock = (await kv.get(K.cards)) || [];
    for (let i = 0; i < n; i++) {
      const odds = pack ? packOdds(stock, pack) : { ok: false };
      if (!odds.ok || !odds.rows.length) break; // plus de stock : les packs restants sont rendus plus bas
      const r = await nextRoll(kv, user.id);
      const card = pickCard(odds.rows, r.roll);
      stock = stock.map(c => c.cardId === card.cardId ? { ...c, qty: c.qty - 1 } : c);
      const uid = 'i' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
      const owned = { uid, itemId: card.cardId, tier: card.lot, from: boxId, value: card.value, name: card.nameFr || card.name, img: playImg(card.img), rarity: card.rarity, set: card.set, number: card.number, at: Date.now() };
      await kv.hset(K.inv(user.id), { [uid]: JSON.stringify(owned) });
      out.push({ item: card.cardId, tier: card.lot, uid, roll: r.roll, nonce: r.nonce, clientSeed: r.clientSeed, serverHash: r.serverHash });
    }
    await kv.set(K.cards, stock);
    return out;
  });

  if (results.length < n) await kv.hincrby(K.credits(user.id), String(boxId), n - results.length);
  if (!results.length) throw new HttpError(409, 'Ce pack est en rupture de stock, tes packs sont conservés');
  await kv.lpush(K.history(user.id), JSON.stringify({ type: 'open', box: boxId, n: results.length, items: results.map(r => r.item), at: Date.now() }));
  await kv.ltrim(K.history(user.id), 0, 199);
  return { results, state: await state(kv, user) };
}

async function buy(kv, req, user, { boxId, count }) {
  const n = Math.min(MAX_OPEN, Math.max(1, Math.floor(+count || 1)));
  const { boxes } = await catalog(kv);
  const box = boxes.find(b => b.id === boxId);
  if (!box || !box.available) throw new HttpError(409, 'Ce booster sera bientôt disponible');
  const inStock = box.table.reduce((a, r) => a + r.qty, 0);
  if (inStock < n) throw new HttpError(409, inStock ? `Plus que ${inStock} pack${inStock > 1 ? 's' : ''} disponible${inStock > 1 ? 's' : ''}` : 'Pack en rupture de stock');
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: user.email,
    line_items: [{ quantity: n, price_data: { currency: 'eur', unit_amount: Math.round(box.price * 100), product_data: { name: `Eden Vault — ${box.name}`, description: `${box.tagline}. La carte est conservée dans ton coffre jusqu'à ce que tu demandes l'envoi.` } } }],
    metadata: { type: 'vault', uid: user.id, email: user.email, boxId: box.id, count: String(n) },
    success_url: `${SITE}/vault?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE}/vault?cancel=1`,
  });
  return { url: session.url };
}

async function rotateSeed(kv, user, { clientSeed }) {
  const old = await getSeeds(kv, user.id);
  const lastNonce = Number(await kv.get(K.nonce(user.id))) || 0;
  const cs = String(clientSeed || '').trim().slice(0, 64) || newSeed(8);
  await kv.set(K.seed(user.id), JSON.stringify({ server: newSeed(32), client: cs }));
  await kv.set(K.nonce(user.id), 0);
  return { revealed: { serverSeed: old.server, serverHash: sha256(old.server), clientSeed: old.client, lastNonce }, state: await state(kv, user) };
}

async function admin(kv, body) {
  if (body.action === 'admin_info') return { open: !!(await kv.get(K.open)) };
  if (body.action === 'admin_open') { await kv.set(K.open, !!body.open); return { open: !!body.open }; }
  if (body.action === 'admin_grant') {
    const email = String(body.email || '').trim().toLowerCase();
    const user = await kv.get(`user:${email}`);
    if (!user) throw new HttpError(404, 'Aucun compte avec cet e-mail');
    const n = Math.min(50, Math.max(1, Math.floor(+body.count || 1)));
    if (!['ar', 'ex'].includes(body.boxId)) throw new HttpError(400, 'Pack inconnu');
    const total = await kv.hincrby(K.credits(user.id), body.boxId, n);
    return { email, boxId: body.boxId, credits: total };
  }
  throw new HttpError(400, 'Action admin inconnue');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const { kv } = require('@vercel/kv');
    const opened = !!(await kv.get(K.open));

    if (req.method === 'GET') {
      if ((req.query && req.query.q) !== 'config') return res.status(400).json({ error: 'Requête inconnue' });
      if (!opened && !isAdmin(req)) return res.status(200).json({ closed: true });
      const { items, boxes } = await catalog(kv);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ open: opened, preview: !opened, imgBase: '', maxOpen: MAX_OPEN, items, boxes: publicBoxes(boxes) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = typeof req.body === 'string' ? (parse(req.body) || {}) : (req.body || {});
    if (String(body.action || '').startsWith('admin_')) {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Accès refusé' });
      return res.status(200).json(await admin(kv, body));
    }
    if (!opened && !isAdmin(req)) return res.status(403).json({ error: 'Le Vault ouvre bientôt' });
    const user = await getUser(kv, req);
    switch (body.action) {
      case 'state': return res.status(200).json(await state(kv, user));
      case 'open': return res.status(200).json(await open(kv, user, body));
      case 'buy': return res.status(200).json(await buy(kv, req, user, body));
      case 'rotate_seed': return res.status(200).json(await rotateSeed(kv, user, body));
      default: return res.status(400).json({ error: 'Action inconnue' });
    }
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...(e.data || {}) });
    console.error('vault:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
