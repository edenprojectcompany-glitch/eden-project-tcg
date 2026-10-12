// api/cards.js — Cartes à l'unité (japonaises) pour les boosters mystère du Vault
// Recherche à la demande sur la base officielle pokemon-card.com + stock admin.
// Env requis : ADMIN_CODE, KV_REST_API_URL, KV_REST_API_TOKEN
//
// GET  ?q=Dracaufeu M2a | M2a 201 | リザードン | Pikachu AR   → propositions
// GET  ?stock=1                                               → cartes en stock
// POST {action:'add', card:{cardId,…}, qty, value}            → ajoute au stock
// POST {action:'update', id, qty?, value?}                     → modifie
// POST {action:'delete', id}                                   → retire

const NAMES = require('../lib/pokemon-names.json'); // [id, ja, fr, en]

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const OFFICIAL = 'https://www.pokemon-card.com';
const UA = { 'User-Agent': 'Mozilla/5.0 (EdenProjectTCG admin)' };
const STOCK_KEY = 'vault:cards';
const PACKS_KEY = 'vault:packs';  // réglages des packs mystère (prix, marge, raretés, % bonus)
const MAX_DETAILS = 24;      // fiches lues par recherche (nom)
const INDEX_BATCH = 40;      // fiches lues par appel quand il faut tout parcourir (numéro, rareté)
const MAX_PAGES = 15;        // 15 × 39 = 585 résultats officiels au maximum

const RARITIES = ['C', 'U', 'R', 'RR', 'RRR', 'AR', 'SAR', 'SR', 'UR', 'HR', 'MUR', 'MA', 'BWR', 'CHR', 'CSR', 'ACE', 'S', 'SSR', 'K', 'PR', 'TR'];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isJa = s => /[぀-ヿ一-鿿]/.test(s);

// Nom FR/EN → nom japonais (correspondance exacte, sinon début du nom)
function toJapanese(name) {
  if (!name) return null;
  if (isJa(name)) return name;
  const n = norm(name);
  if (!n) return null;
  const exact = NAMES.find(([, , fr, en]) => norm(fr) === n || norm(en) === n);
  if (exact) return exact[1];
  const pref = NAMES.filter(([, , fr, en]) => norm(fr).startsWith(n) || norm(en).startsWith(n))
    .sort((a, b) => a[2].length - b[2].length);
  return pref.length ? pref[0][1] : null;
}
const frName = ja => {
  const hit = NAMES.filter(([, j]) => ja.includes(j)).sort((a, b) => b[1].length - a[1].length)[0];
  return hit ? hit[2] : '';
};

// « Dracaufeu M2a AR 201 » → { name, set, number, rarity, mega, ex }
function parseQuery(q) {
  const out = { words: [] };
  for (const raw of String(q || '').trim().split(/\s+/).filter(Boolean)) {
    const t = raw.replace(/[,;]/g, '');
    const up = t.toUpperCase();
    const num = t.match(/^(\d{1,3})(?:\/\d{1,3})?$/);
    if (num) { out.number = +num[1]; continue; }
    if (RARITIES.includes(up) && up.length >= 2) { out.rarity = up; continue; }
    // Codes de set japonais : M2a, SV11B, S12a, SM8b, MC, M-P… (la base officielle ignore la casse)
    if (/^(M|SV|S|SM)\d{1,2}[A-Z]{0,2}$|^(MC|MF|M-P|SV-P|S-P)$/i.test(t)) { out.set = t; continue; }
    if (/^m[ée]ga$/i.test(t)) { out.mega = true; continue; }
    if (/^ex$/i.test(t)) { out.ex = true; continue; }
    out.words.push(t);
  }
  out.name = out.words.join(' ');
  return out;
}

async function officialSearch(params) {
  const qs = new URLSearchParams({ keyword: '', se_ta: '', regulation_sidebar_form: 'all', pg: '', illust: '', sm_and_keyword: 'true', page: 1, ...params });
  const r = await fetch(`${OFFICIAL}/card-search/resultAPI.php?${qs}`, { headers: UA });
  if (!r.ok) throw new Error('Base officielle indisponible (' + r.status + ')');
  const j = await r.json();
  return { maxPage: j.maxPage || 1, hits: j.hitCnt || 0, list: (j.cardList || []).map(c => ({ cardId: c.cardID, name: c.cardNameViewText, img: OFFICIAL + c.cardThumbFile })) };
}

// Fiche officielle → numéro, total, rareté, set (mise en cache définitive)
async function details(kv, card) {
  const key = 'cards:detail:' + card.cardId;
  const cached = await kv.get(key);
  if (cached) return { ...card, ...cached };
  const r = await fetch(`${OFFICIAL}/card-search/details.php/card/${card.cardId}/regu/all`, { headers: UA });
  const html = r.ok ? await r.text() : '';
  const num = html.match(/(\d{1,3})&nbsp;\/&nbsp;(\d{1,3})/);
  const rar = html.match(/ic_rare_([a-z0-9]+)\.gif/i);
  const set = html.match(/regulation_logo_\d+\/([^.]+)\.gif/) || card.img.match(/card_images\/large\/([^/]+)\//);
  const info = {
    number: num ? +num[1] : null,
    total: num ? +num[2] : null,
    rarity: rar ? rar[1].toUpperCase() : '',
    set: set ? decodeURIComponent(set[1]) : '',
  };
  if (html) await kv.set(key, info);
  return { ...card, ...info };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const decorate = c => ({ ...c, nameFr: frName(c.name), label: `${c.set || '?'} ${c.number ? String(c.number).padStart(3, '0') + '/' + c.total : ''}`.trim() });

function filterCards(cards, p) {
  return cards.filter(c =>
    (!p.number || c.number === p.number) &&
    (!p.rarity || c.rarity === p.rarity) &&
    (!p.mega || c.name.includes('メガ')) &&
    (!p.ex || /ex$/i.test(c.name)) &&
    (!p.set || c.set.toLowerCase() === p.set.toLowerCase()));
}

// Liste complète des résultats officiels pour (nom JP, set), mise en cache une semaine
async function resultList(kv, keyword, set) {
  const key = 'cards:list:' + keyword + '|' + set.toLowerCase();
  const cached = await kv.get(key);
  if (cached) return cached;
  const first = await officialSearch({ keyword, pg: set });
  let list = first.list;
  const pages = Math.min(first.maxPage, MAX_PAGES);
  for (let page = 2; page <= pages; page++) list = list.concat((await officialSearch({ keyword, pg: set, page })).list);
  await kv.set(key, list, { ex: 60 * 60 * 24 * 7 });
  return list;
}

async function search(kv, q) {
  const p = parseQuery(q);
  if (!p.name && !p.set) return { results: [], message: 'Tape un nom (français, anglais ou japonais) et/ou un code de set (ex. M2a).' };
  const ja = p.name ? toJapanese(p.name) : '';
  if (p.name && !ja) return { results: [], message: `Nom « ${p.name} » inconnu. Essaie le nom anglais ou japonais.` };
  let list = await resultList(kv, ja, p.set || '');
  if (!list.length) return { results: [], message: p.set && !p.name ? `Set « ${p.set} » introuvable sur la base officielle.` : 'Aucune carte trouvée.' };
  // Pré-filtre sur le nom avant de lire les fiches
  if (p.mega) list = list.filter(c => c.name.includes('メガ'));
  if (p.ex) list = list.filter(c => /ex$/i.test(c.name));
  const query = { ...p, ja };
  const filtered = p.number || p.rarity || !p.name;
  if (!filtered) {
    const cards = await mapLimit(list.slice(0, MAX_DETAILS), 8, c => details(kv, c));
    return { query, hits: list.length, results: cards.map(decorate) };
  }
  // Numéro ou rareté : il faut toutes les fiches. Lues par lots la première fois, puis en cache.
  const known = await mapLimit(list, 16, async c => { const d = await kv.get('cards:detail:' + c.cardId); return d ? { ...c, ...d } : null; });
  const missing = list.filter((c, i) => !known[i]);
  if (missing.length > INDEX_BATCH) {
    await mapLimit(missing.slice(0, INDEX_BATCH), 8, c => details(kv, c));
    return { indexing: true, progress: { done: list.length - missing.length + INDEX_BATCH, total: list.length }, results: [] };
  }
  const all = known.map((c, i) => c || null);
  const read = await mapLimit(missing, 8, c => details(kv, c));
  let j = 0;
  for (let i = 0; i < all.length; i++) if (!all[i]) all[i] = read[j++];
  return { query, hits: list.length, results: filterCards(all, { ...p, set: null }).slice(0, 60).map(decorate) };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const code = req.headers['x-admin-code'];
  if (!code || code !== process.env.ADMIN_CODE) return res.status(403).json({ error: 'Accès refusé' });

  try {
    const { kv } = require('@vercel/kv');

    if (req.method === 'GET') {
      if (req.query.stock) return res.status(200).json({ cards: (await kv.get(STOCK_KEY)) || [], packs: (await kv.get(PACKS_KEY)) || {} });
      return res.status(200).json(await search(kv, req.query.q));
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

      // Réglage d'un pack mystère (calculateur de l'admin)
      if (body.action === 'save_pack') {
        const p = body.pack || {};
        if (!/^[a-z0-9_-]{2,30}$/.test(String(p.id || ''))) return res.status(400).json({ error: 'Pack invalide' });
        const rar = a => (Array.isArray(a) ? a : []).map(String).filter(r => RARITIES.includes(r));
        const packs = (await kv.get(PACKS_KEY)) || {};
        packs[p.id] = {
          id: p.id, name: String(p.name || p.id).slice(0, 40),
          price: Math.max(0, +p.price || 0), margin: Math.min(90, Math.max(0, +p.margin || 0)),
          base: rar(p.base), bonus: rar(p.bonus), bonusPct: Math.min(50, Math.max(0, +p.bonusPct || 0)),
          feePct: Math.max(0, +p.feePct || 0), feeFix: Math.max(0, +p.feeFix || 0), updatedAt: Date.now(),
        };
        await kv.set(PACKS_KEY, packs);
        return res.status(200).json({ packs });
      }

      const cards = (await kv.get(STOCK_KEY)) || [];
      const qty = Math.max(0, Math.floor(+body.qty || 0));
      const value = Math.max(0, Math.round((+body.value || 0) * 100) / 100);

      if (body.action === 'add') {
        const c = body.card || {};
        if (!/^\d+$/.test(String(c.cardId || ''))) return res.status(400).json({ error: 'Carte invalide' });
        if (!qty) return res.status(400).json({ error: 'Quantité requise' });
        // Les infos viennent de la base officielle (cache), pas du navigateur
        const d = await details(kv, { cardId: String(c.cardId), name: String(c.name || '').slice(0, 80), img: String(c.img || '') });
        if (!d.img.startsWith(OFFICIAL + '/assets/images/card_images/')) return res.status(400).json({ error: 'Image invalide' });
        const existing = cards.find(x => x.cardId === d.cardId);
        if (existing) { existing.qty += qty; if (value) existing.value = value; existing.updatedAt = Date.now(); }
        else cards.unshift({ id: 'crd_' + d.cardId, cardId: d.cardId, name: d.name, nameFr: frName(d.name), set: d.set, number: d.number, total: d.total, rarity: d.rarity, img: d.img, qty, value, addedAt: Date.now() });
        await kv.set(STOCK_KEY, cards);
        return res.status(200).json({ cards });
      }
      const card = cards.find(x => x.id === body.id);
      if (!card) return res.status(404).json({ error: 'Carte introuvable' });
      if (body.action === 'update') {
        if (body.qty !== undefined) card.qty = qty;
        if (body.value !== undefined) card.value = value;
        card.updatedAt = Date.now();
        await kv.set(STOCK_KEY, cards);
        return res.status(200).json({ cards });
      }
      if (body.action === 'delete') {
        const next = cards.filter(x => x.id !== body.id);
        await kv.set(STOCK_KEY, next);
        return res.status(200).json({ cards: next });
      }
      return res.status(400).json({ error: 'Action inconnue' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('cards:', e);
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};
