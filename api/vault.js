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
//
// Booster cadeau (ex-roue, lib/gift.js) — accessible même quand le Vault est fermé :
// GET  ?q=config&gift=1                  → le booster cadeau seul, avec ses gains et leurs chances
// POST {action:'gift_state'}             → éligibilité du joueur (premier achat, délai)
// POST {action:'open_gift'}              → tirage vérifiable, code à usage unique valable 30 jours
// POST {action:'demo_open', boxId, count}→ démo gratuite : rien n'est débité, stock et coffre intacts

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { packOdds, pickCard } = require('../lib/vault-odds');
const { giftStatus, giftTable, pickGift, awardGift } = require('../lib/gift');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const SITE = process.env.SITE_URL || 'https://www.edenprojecttcg.com';
const MAX_OPEN = 10;
// Les deux boosters mystère : illustration animée sur le sachet, nom et prix par défaut
// (le nom et le prix réels viennent du calculateur de l'admin dès qu'un réglage est enregistré)
const PACK_INFO = {
  ar: { name: 'Mystère AR', price: 9.9, tagline: '1 carte AR garantie', theme: ['#ffd97f', '#c9a8ff'], art: '/image/vault3d/mew-sm.jpg', artKind: 'flames' },
  ex: { name: 'Mystère EX', price: 4.9, tagline: '1 carte ex garantie', theme: ['#7fd9ff', '#b98aff'], art: '/image/vault3d/pack-dracaufeu.jpg', artKind: 'sky' },
  // Booster Légende : 2 boosters scellés tirés dans le stock « Lots scellés » (151, SV8a, SV10, M2a, CN151, 30 ans CN…)
  legend: { name: 'Booster Légende', price: 19.9, tagline: '2 boosters scellés garantis', theme: ['#c77dff', '#5ad1ff'], art: '/image/vault3d/pack-mewtwo.jpg', artKind: 'psy', artAspect: 1.25, draws: 2, sealed: true },
};
// Réglage par défaut du Booster Légende (modifiable dans le calculateur de l'admin)
const DEFAULT_LEGEND = { price: 19.9, margin: 25, base: ['BOOSTER', 'BOOSTER30'], bonus: ['DISPLAY'], bonusPct: 2, feePct: 1.5, feeFix: .25 };
const BOX_IDS = ['ar', 'ex', 'legend'];

const K = {
  open: 'vault:open', cards: 'vault:cards', packs: 'vault:packs', sealed: 'vault:sealed', lock: 'vault:lock:stock',
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
async function getAccount(kv, req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) throw new HttpError(401, 'Connecte-toi pour continuer');
  let d;
  try { d = jwt.verify(token, process.env.JWT_SECRET); } catch { throw new HttpError(401, 'Session expirée, reconnecte-toi'); }
  const key = `user:${String(d.email || '').toLowerCase().trim()}`;
  const user = await kv.get(key);
  if (!user) throw new HttpError(401, 'Compte introuvable');
  if (user.tokenVersion != null && d.tokenVersion !== user.tokenVersion) throw new HttpError(401, 'Session expirée, reconnecte-toi');
  return { key, user };
}
async function getUser(kv, req) {
  const { user } = await getAccount(kv, req);
  return { id: user.id, email: user.email, name: user.name };
}

// ── Booster cadeau ─────────────────────────────────────────────
// Niveau d'animation de chaque gain (le booster offert est le gros lot)
const GIFT_TIER = { EDEN5: 'common', SHIP0: 'uncommon', MOINS10: 'rare', BOOSTER: 'legendary' };
const giftItemId = seg => 'gift-' + (seg.code || seg.label);
async function giftConfig(kv) {
  const table = await giftTable(kv);
  const items = Object.fromEntries(table.map(seg => [giftItemId(seg), {
    id: giftItemId(seg), kind: 'coupon', name: seg.label, short: seg.label, code: seg.code, color: seg.color, value: 0, rarity: 'CADEAU',
  }]));
  const box = {
    id: 'gift', name: 'Booster cadeau', tagline: 'Un code offert à chaque ouverture', price: 0, free: true, theme: ['#ffd97f', '#ff8f8f'],
    draws: 1, available: true, ev: 0,
    table: table.map(seg => ({ itemId: giftItemId(seg), p: (+seg.prob || 0) / 100, tier: GIFT_TIER[seg.code] || 'uncommon' })),
  };
  return { gift: true, imgBase: '', maxOpen: 1, items, boxes: [box] };
}
// ── Mode démo : ouverture gratuite, sans paiement, sans toucher au stock ni au coffre ──
// Sans réglage enregistré, on prend les préréglages de l'admin ; chaque lot compte pour 1 exemplaire.
const DEMO_PACKS = {
  ar: { name: 'Mystère AR', base: ['AR'], bonus: ['SAR'], bonusPct: 3, price: 9.9, margin: 25, feePct: 1.5, feeFix: .25 },
  ex: { name: 'Mystère EX', base: ['RR'], bonus: ['AR', 'SAR'], bonusPct: 5, price: 4.9, margin: 25, feePct: 1.5, feeFix: .25 },
};
const DEMO_SEALED = [
  { id: 'sv2a', name: 'Booster Pokémon 151 (SV2a)', lang: 'jp', kind: 'booster', tag: 'BOOSTER', img: '/image/packs/sv2a.webp', value: 15 },
  { id: 'sv8a', name: 'Booster Terastal Festival (SV8a)', lang: 'jp', kind: 'booster', tag: 'BOOSTER', img: '/image/packs/sv8a.webp', value: 10 },
  { id: 'sv10', name: 'Booster Glory Team Rocket (SV10)', lang: 'jp', kind: 'booster', tag: 'BOOSTER', img: '/image/packs/sv10.webp', value: 5 },
  { id: 'm2a', name: 'Booster Méga Dream ex (M2a)', lang: 'jp', kind: 'booster', tag: 'BOOSTER', img: '/image/packs/m2a.webp', value: 9 },
  { id: 'cn151-3', name: 'Booster CN151 Vol.3', lang: 'cn', kind: 'booster', tag: 'BOOSTER', img: '/image/packs/cn151-3.webp', value: 5 },
  { id: 'cn-30ans', name: 'Booster 30 ans (chinois)', lang: 'cn', kind: 'booster', tag: 'BOOSTER30', img: '/image/packs/cn-30ans.png', value: 8 },
];
async function demoOpen(kv, { boxId, count }) {
  if (boxId === 'gift') {
    const table = await giftTable(kv), prize = pickGift(table, Math.random());
    return { demo: true, results: [{ item: giftItemId(prize), tier: GIFT_TIER[prize.code] || 'uncommon' }], won: { code: prize.code, label: prize.label, expiresAt: new Date(Date.now() + 30 * 864e5).toISOString() } };
  }
  const info = PACK_INFO[boxId];
  if (!info) throw new HttpError(404, 'Booster inconnu');
  const [cards, sealed, packs] = await Promise.all([kv.get(K.cards), kv.get(K.sealed), kv.get(K.packs)]);
  const lots = (sealed || []).length ? sealed : DEMO_SEALED;
  const saved = (packs || {})[boxId] || {};
  const src = packSource(boxId, cards, lots, saved.price > 0 ? packs : { ...packs, [boxId]: DEMO_PACKS[boxId] || saved });
  const pool = src.pool.map(c => ({ ...c, qty: Math.max(1, +c.qty || 0) }));
  const odds = packOdds(pool, src.perDraw);
  if (!odds.ok || !odds.rows.length) throw new HttpError(409, info.sealed ? 'Aucun lot scellé pour la démo' : 'Ajoute des cartes dans « Cartes Vault » pour essayer ce booster');
  const n = Math.min(MAX_OPEN, Math.max(1, Math.floor(+count || 1))) * src.draws;
  const results = [], items = {};
  for (let i = 0; i < n; i++) {
    const c = pickCard(odds.rows, Math.random());
    items[c.cardId] = { id: c.cardId, kind: c.kind || 'card', name: c.kind ? c.name : (c.nameFr ? `${c.nameFr} · ${c.rarity}` : c.name), short: c.nameFr || c.name, img: playImg(c.img), value: c.value, rarity: c.rarity, set: c.set, number: c.number, total: c.total, intlPreview: !!c.intlPreview };
    results.push({ item: c.cardId, tier: c.lot });
  }
  return { demo: true, results, items: publicItems(items) };
}
const publicGiftStatus = user => { const s = giftStatus(user); return { eligible: s.eligible, reason: s.reason, nextAt: s.nextAt }; };
async function openGift(kv, req) {
  const { key, user: u0 } = await getAccount(kv, req);
  // Même verrou que /api/spin : un seul tirage à la fois par compte
  const lock = `spin:lock:${u0.email.toLowerCase().trim()}`;
  if (!(await kv.set(lock, '1', { ex: 15, nx: true }))) throw new HttpError(429, 'Ouverture déjà en cours, réessaie dans quelques secondes');
  try {
    const user = await kv.get(key);
    const st = giftStatus(user);
    if (!st.eligible) throw new HttpError(st.reason === 'first-order' ? 403 : 429, st.reason === 'first-order' ? 'Ton booster cadeau se débloque après ton premier achat' : 'Ton prochain booster cadeau n’est pas encore prêt', { status: publicGiftStatus(user) });
    const table = await giftTable(kv);
    const r = await nextRoll(kv, user.id);
    const prize = pickGift(table, r.roll);
    const won = awardGift(user, prize);
    user.loyalty = (user.loyalty || 0) + 10 + (prize.code ? 20 : 0);
    await kv.set(key, user);
    const lite = { id: user.id, email: user.email, name: user.name };
    return {
      results: [{ item: giftItemId(prize), tier: GIFT_TIER[prize.code] || 'uncommon', roll: r.roll, nonce: r.nonce, clientSeed: r.clientSeed, serverHash: r.serverHash }],
      won: { code: won.code, label: won.label, expiresAt: won.expiresAt }, status: publicGiftStatus(user), state: await state(kv, lite),
    };
  } finally { await kv.del(lock).catch(() => {}); }
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
// Lots scellés (boosters, displays) présentés comme des « cartes » pour le calcul des chances
const sealedPool = lots => (lots || []).map(l => ({
  cardId: 'sl-' + l.id, name: l.name, nameFr: l.name, rarity: l.tag, value: +l.value || 0, qty: +l.qty || 0,
  img: l.img, set: l.set || '', kind: l.kind === 'display' ? 'display' : 'booster', lang: l.lang,
}));

// Source d'un booster : stock utilisé, réglage, nombre de tirages ; les chances sont calculées PAR TIRAGE
function packSource(id, cards, sealed, packs) {
  const info = PACK_INFO[id], draws = info.draws || 1;
  const saved = (packs && packs[id]) || {};
  // Sans réglage enregistré dans le calculateur : réglage par défaut (mêmes valeurs que les préréglages de l'admin)
  const pack = { ...(info.sealed ? DEFAULT_LEGEND : DEMO_PACKS[id]), ...(saved.price > 0 || info.sealed ? saved : {}) };
  const perDraw = { ...pack, price: (+pack.price || 0) / draws, feeFix: (+pack.feeFix || 0) / draws };
  return { info, draws, pack, perDraw, pool: info.sealed ? sealedPool(sealed) : (cards || []), key: info.sealed ? K.sealed : K.cards };
}

// Les boosters sont toujours présentés ; sans réglage ou sans stock, ils sont « bientôt disponibles »
async function catalog(kv) {
  const [cards, sealed, packs] = await Promise.all([kv.get(K.cards), kv.get(K.sealed), kv.get(K.packs)]);
  const items = {}, boxes = [];
  for (const id of BOX_IDS) {
    const src = packSource(id, cards, sealed, packs), { info, draws, pack } = src;
    const odds = pack.price > 0 ? packOdds(src.pool, src.perDraw) : { ok: false, rows: [], ev: 0 };
    const rows = odds.ok ? odds.rows : [];
    for (const c of rows) items[c.cardId] = {
      id: c.cardId, kind: c.kind || 'card', name: c.kind ? c.name : (c.nameFr ? `${c.nameFr} · ${c.rarity}` : c.name), nameJa: c.name, short: c.nameFr || c.name,
      img: playImg(c.img), value: c.value, rarity: c.rarity, set: c.set, number: c.number, total: c.total, intlPreview: !!c.intlPreview,
    };
    const inStock = rows.reduce((a, r) => a + r.qty, 0);
    boxes.push({
      id, name: pack.name || info.name, tagline: info.tagline, price: pack.price > 0 ? pack.price : info.price, theme: info.theme,
      art: info.art, artKind: info.artKind, artAspect: info.artAspect || 16 / 9, draws, available: rows.length > 0 && inStock >= draws,
      guaranteed: pack.base || [], bonus: (pack.bonus || []).filter(r => !(pack.base || []).includes(r)), bonusPct: +pack.bonusPct || 0,
      ev: round2((odds.ev || 0) * draws), table: rows.map(c => ({ itemId: c.cardId, p: c.p, tier: c.lot, qty: c.qty })),
      _odds: odds, _pack: pack,
    });
  }
  return { items, boxes, stock: cards || [] };
}
// Images officielles servies par notre relais (utilisables en texture 3D)
const playImg = img => /^https:\/\/www\.pokemon-card\.com\//.test(img || '') ? '/api/cards?src=' + encodeURIComponent(img) : img;
const publicBoxes = boxes => boxes.map(({ _odds, _pack, ev, ...b }) => ({ ...b, table: b.table.map(({ qty, ...r }) => r) }));
// Valeur des cartes : jamais montrée aux clients (le prix du marché bouge chaque jour)
const publicItems = items => Object.fromEntries(Object.entries(items).map(([k, { value, ...it }]) => [k, it]));

async function state(kv, user) {
  const [credits, inv] = await Promise.all([kv.hgetall(K.credits(user.id)), kv.hgetall(K.inv(user.id))]);
  const seeds = await getSeeds(kv, user.id);
  const nonce = Number(await kv.get(K.nonce(user.id))) || 0;
  return {
    user: { name: user.name },
    credits: Object.fromEntries(Object.entries(credits || {}).map(([k, v]) => [k, Number(v) || 0]).filter(([, v]) => v > 0)),
    inventory: Object.values(inv || {}).map(parse).filter(Boolean).map(({ value, ...o }) => o).sort((a, b) => b.at - a.at),
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

  if (!PACK_INFO[boxId]) throw new HttpError(404, 'Booster inconnu');
  let opened = 0;
  const results = await withStockLock(kv, async () => {
    const out = [];
    const [packs, cards, sealedLots] = await Promise.all([kv.get(K.packs), kv.get(K.cards), kv.get(K.sealed)]);
    const src = packSource(boxId, cards, sealedLots, packs);
    const isSealed = !!src.info.sealed;
    let lots = isSealed ? (sealedLots || []) : null;
    let stock = isSealed ? sealedPool(lots) : (cards || []);
    for (let i = 0; i < n; i++) {
      // Un booster n'est ouvert que si son contenu complet (draws lots) est disponible
      const avail = stock.filter(c => c.qty > 0).reduce((a, c) => a + c.qty, 0);
      if (!(src.pack.price > 0) || avail < src.draws) break;
      const pull = [];
      for (let d = 0; d < src.draws; d++) {
        const odds = packOdds(stock, src.perDraw);
        if (!odds.ok || !odds.rows.length) break;
        const r = await nextRoll(kv, user.id);
        const card = pickCard(odds.rows, r.roll);
        stock = stock.map(c => c.cardId === card.cardId ? { ...c, qty: c.qty - 1 } : c);
        pull.push({ card, r });
      }
      if (pull.length < src.draws) { for (const { card } of pull) stock = stock.map(c => c.cardId === card.cardId ? { ...c, qty: c.qty + 1 } : c); break; }
      for (const { card, r } of pull) {
        const uid = 'i' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        const owned = { uid, itemId: card.cardId, tier: card.lot, from: boxId, value: card.value, name: card.nameFr || card.name, img: playImg(card.img), rarity: card.rarity, set: card.set, number: card.number, kind: card.kind || 'card', at: Date.now() };
        await kv.hset(K.inv(user.id), { [uid]: JSON.stringify(owned) });
        out.push({ item: card.cardId, tier: card.lot, uid, roll: r.roll, nonce: r.nonce, clientSeed: r.clientSeed, serverHash: r.serverHash });
      }
      opened++;
    }
    if (isSealed) {
      const left = Object.fromEntries(stock.map(c => [c.cardId, c.qty]));
      await kv.set(K.sealed, lots.map(l => ({ ...l, qty: left['sl-' + l.id] ?? l.qty })));
    } else await kv.set(K.cards, stock);
    return out;
  });

  if (opened < n) await kv.hincrby(K.credits(user.id), String(boxId), n - opened);
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
  const inStock = Math.floor(box.table.reduce((a, r) => a + r.qty, 0) / (box.draws || 1));
  if (inStock < n) throw new HttpError(409, inStock ? `Plus que ${inStock} booster${inStock > 1 ? 's' : ''} disponible${inStock > 1 ? 's' : ''}` : 'Booster en rupture de stock');
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
    if (!BOX_IDS.includes(body.boxId)) throw new HttpError(400, 'Pack inconnu');
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
      if (req.query.gift === '1') { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ ...(await giftConfig(kv)), open: opened }); }
      if (!opened && !isAdmin(req)) return res.status(200).json({ closed: true });
      const { items, boxes } = await catalog(kv);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ open: opened, preview: !opened, imgBase: '', maxOpen: MAX_OPEN, items: publicItems(items), boxes: publicBoxes(boxes) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = typeof req.body === 'string' ? (parse(req.body) || {}) : (req.body || {});
    if (String(body.action || '').startsWith('admin_')) {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Accès refusé' });
      return res.status(200).json(await admin(kv, body));
    }
    // Booster cadeau et coffre du joueur : disponibles même avant l'ouverture publique du Vault
    if (body.action === 'gift_state') { const { user } = await getAccount(kv, req); return res.status(200).json({ status: publicGiftStatus(user) }); }
    if (body.action === 'open_gift') return res.status(200).json(await openGift(kv, req));
    // Démo : le booster cadeau pour tous, les autres boosters une fois le Vault ouvert (ou avec le code admin)
    if (body.action === 'demo_open') {
      if (body.boxId !== 'gift' && !opened && !isAdmin(req)) return res.status(403).json({ error: 'Le Vault ouvre bientôt' });
      return res.status(200).json(await demoOpen(kv, body));
    }
    if (body.action === 'state') return res.status(200).json(await state(kv, await getUser(kv, req)));
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
