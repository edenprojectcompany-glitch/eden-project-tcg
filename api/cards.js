// api/cards.js — Cartes à l'unité (japonaises) pour les boosters mystère du Vault
// Recherche à la demande sur la base officielle pokemon-card.com (images, numéros)
// complétée par TCGdex (raretés manquantes, cartes pas encore publiées par Pokémon) + stock admin.
// Env requis : ADMIN_CODE, KV_REST_API_URL, KV_REST_API_TOKEN
//
// GET  ?q=Dracaufeu M2a | M2a 201 | Mewtwo 30 ans SAR | リザードン   → propositions (admin)
// GET  ?stock=1                                                    → cartes en stock + réglages packs (admin)
// GET  ?img=<cardId>                                               → photo d'une carte ajoutée à la main (public)
// POST {action:'add', card:{cardId,…}, qty, value, imageData?}     → ajoute au stock
// POST {action:'update', id, qty?, value?}                          → modifie
// POST {action:'delete', id}                                        → retire
// POST {action:'save_pack', pack:{…}}                               → réglage d'un pack mystère

const NAMES = require('../lib/pokemon-names.json'); // [id, ja, fr, en]

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const OFFICIAL = 'https://www.pokemon-card.com';
const TCGDEX = 'https://api.tcgdex.net/v2/ja';
const UA = { 'User-Agent': 'Mozilla/5.0 (EdenProjectTCG admin)' };
const STOCK_KEY = 'vault:cards';
const PACKS_KEY = 'vault:packs';  // réglages des packs mystère (prix, marge, raretés, % bonus)
const MAX_DETAILS = 24;      // fiches lues par recherche (nom)
const INDEX_BATCH = 40;      // fiches lues par appel quand il faut tout parcourir (numéro, rareté)
const MAX_PAGES = 15;        // 15 × 39 = 585 résultats officiels au maximum
const MAX_IMG = 450 * 1024;
// Sets récents dont Pokémon n'a pas encore publié toutes les cartes : vérifiés même sans set dans la recherche
const RECENT_SETS = ['M6a', 'M6'];  // photo envoyée depuis l'admin (déjà réduite par le navigateur)

const RARITIES = ['C', 'U', 'R', 'RR', 'RRR', 'AR', 'SAR', 'SR', 'UR', 'HR', 'MUR', 'MA', 'BWR', 'CHR', 'CSR', 'ACE', 'S', 'SSR', 'K', 'PR', 'TR', 'CC', 'RGB', 'FR'];
// Libellés TCGdex → codes de rareté japonais
const TCG_RARITY = {
  'common': 'C', 'uncommon': 'U', 'rare': 'R', 'double rare': 'RR', 'triple rare': 'RRR',
  'illustration rare': 'AR', 'special illustration rare': 'SAR', 'ultra rare': 'SR', 'hyper rare': 'UR',
  'mega hyper rare': 'MUR', 'shiny rare': 'S', 'shiny ultra rare': 'SSR', 'ace spec rare': 'ACE',
  'black white rare': 'BWR', 'character holo rare': 'CHR', 'character super rare': 'CSR',
  'classic collection': 'CC', 'rgb rare': 'RGB', 'futuristic rare': 'FR',
};
// Noms de sets tapés en toutes lettres → code officiel
const SET_ALIASES = [
  [/\b30\s*(?:ans|th|[eè]me?)\b(?:\s+(?:anniversaire|anniversary|celebration))?/gi, 'M6a'],
  [/\b(?:anniversaire|anniversary|celebration)\b/gi, 'M6a'],
  [/\bm[ée]ga\s+dream(?:\s+ex)?\b/gi, 'M2a'], [/\binferno\s*x\b/gi, 'M2'], [/\bm[ée]ga\s+brave\b/gi, 'M1L'],
  [/\bm[ée]ga\s+symphonia\b/gi, 'M1S'], [/\b(?:nihil|munikis)\s+zero\b/gi, 'M3'], [/\bninja\s+spinner\b/gi, 'M4'],
  [/\babyss\s+eye\b/gi, 'M5'], [/\bstorm\s+emeralda?\b/gi, 'M6'], [/\bterastal\s+fest(?:ival)?\b/gi, 'SV8a'],
  [/\bbattle\s+partners\b/gi, 'SV9'], [/\bheat\s*wave(?:\s+arena)?\b/gi, 'SV9a'],
  [/\b(?:glory\s+(?:of\s+)?)?team\s+rocket\b/gi, 'SV10'], [/\bblack\s+bolt\b/gi, 'SV11B'],
  [/\bwhite\s+flare\b/gi, 'SV11W'], [/\bpok[ée]mon\s+151\b/gi, 'SV2a'],
];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isJa = s => /[぀-ヿ一-鿿]/.test(s);
// Noms officiels : le symbole Méga est une balise HTML
const cleanName = s => String(s || '').replace(/<span class="pcg pcg-megamark"><\/span>/g, 'M').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();

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

// « Mewtwo 30 ans SAR » → { name, set, number, rarity, mega, ex }
function parseQuery(q) {
  const out = { words: [] };
  let text = String(q || '');
  for (const [re, code] of SET_ALIASES) text = text.replace(re, ' ' + code + ' ');
  for (const raw of text.trim().split(/\s+/).filter(Boolean)) {
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
  return { maxPage: j.maxPage || 1, hits: j.hitCnt || 0, list: (j.cardList || []).map(c => ({ cardId: c.cardID, name: cleanName(c.cardNameViewText), img: OFFICIAL + c.cardThumbFile })) };
}

async function tcgdex(path) {
  try { const r = await fetch(TCGDEX + path); return r.ok ? await r.json() : null; } catch { return null; }
}
const tcgId = (set, number) => `${set}-${String(number).padStart(3, '0')}`;
const tcgRarity = label => TCG_RARITY[String(label || '').toLowerCase()] || '';

// Fiche officielle → numéro, total, rareté, set (mise en cache définitive)
// Si Pokémon n'affiche pas encore la rareté (sets récents), on la prend chez TCGdex.
async function details(kv, card) {
  const key = 'cards:detail:' + card.cardId;
  const cached = await kv.get(key);
  if (cached && (cached.rarity || cached.tcgChecked)) return { ...card, ...cached };
  let info = cached;
  if (!info) {
    const r = await fetch(`${OFFICIAL}/card-search/details.php/card/${card.cardId}/regu/all`, { headers: UA });
    const html = r.ok ? await r.text() : '';
    if (!html) return { ...card, number: null, total: null, rarity: '', set: '' };
    const num = html.match(/(\d{1,3})&nbsp;\/&nbsp;(\d{1,3})/);
    const rar = html.match(/ic_rare_([a-z0-9]+)\.gif/i);
    const set = html.match(/regulation_logo_\d+\/([^.]+)\.gif/) || card.img.match(/card_images\/large\/([^/]+)\//);
    info = { number: num ? +num[1] : null, total: num ? +num[2] : null, rarity: rar ? rar[1].toUpperCase() : '', set: set ? decodeURIComponent(set[1]) : '' };
  }
  if (!info.rarity && info.set && info.number) {
    const t = await tcgdex('/cards/' + tcgId(info.set, info.number));
    info = { ...info, rarity: tcgRarity(t && t.rarity) };
  }
  info.tcgChecked = true;
  await kv.set(key, info);
  return { ...card, ...info };
}

// Cartes d'un set connues de TCGdex mais pas encore publiées sur le site officiel (pas d'image)
async function unpublished(kv, set, officialNumbers, p, ja) {
  const key = 'cards:tcgset:' + set.toLowerCase();
  let s = await kv.get(key);
  if (!s) {
    let j = await tcgdex('/sets/' + encodeURIComponent(set));
    if (!j) { // TCGdex respecte la casse (M6a, SV11B) : on retrouve le bon identifiant
      const all = (await tcgdex('/sets')) || [];
      const hit = all.find(x => x.id.toLowerCase() === set.toLowerCase());
      if (hit) j = await tcgdex('/sets/' + encodeURIComponent(hit.id));
    }
    if (!j || !j.cards) return [];
    s = { id: j.id, total: j.cardCount && j.cardCount.official, cards: j.cards.filter(c => /^\d+$/.test(c.localId)).map(c => ({ n: +c.localId, name: c.name })) };
    await kv.set(key, s, { ex: 60 * 60 * 24 });
  }
  const known = new Set(officialNumbers);
  let cands = s.cards.filter(c => !known.has(c.n) && (!ja || c.name.includes(ja)) && (!p.number || c.n === p.number) &&
    (!p.mega || c.name.includes('メガ')) && (!p.ex || /ex$/i.test(c.name)));
  cands = await mapLimit(cands.slice(0, 60), 8, async c => {
    const id = tcgId(s.id, c.n), ck = 'cards:tcg:' + id;
    let rarity = await kv.get(ck);
    if (rarity === null) { const t = await tcgdex('/cards/' + id); rarity = tcgRarity(t && t.rarity); await kv.set(ck, rarity); }
    return { cardId: 'tcg-' + id, name: c.name, set: s.id, number: c.n, total: s.total, rarity, img: '', unpublished: true };
  });
  return cands.filter(c => !p.rarity || c.rarity === p.rarity);
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
  const key = 'cards:list2:' + keyword + '|' + set.toLowerCase();
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
  if (!p.name && !p.set) return { results: [], message: 'Tape un nom (français, anglais ou japonais) et/ou un set (M2a, « 30 ans », « Black Bolt »…).' };
  const ja = p.name ? toJapanese(p.name) : '';
  if (p.name && !ja) return { results: [], message: `Nom « ${p.name} » inconnu. Essaie le nom anglais ou japonais.` };
  const query = { ...p, ja };
  let list = await resultList(kv, ja, p.set || '');
  // Pré-filtre sur le nom avant de lire les fiches
  if (p.mega) list = list.filter(c => c.name.includes('メガ'));
  if (p.ex) list = list.filter(c => /ex$/i.test(c.name));
  // Avec un set précis, on lit toutes ses fiches pour repérer aussi les cartes pas encore publiées
  const readAll = p.number || p.rarity || !p.name || p.set;
  let cards;
  if (!readAll) {
    cards = await mapLimit(list.slice(0, MAX_DETAILS), 8, c => details(kv, c));
  } else {
    // Toutes les fiches : lues par lots la première fois, puis en cache
    const known = await mapLimit(list, 16, async c => { const d = await kv.get('cards:detail:' + c.cardId); return d && (d.rarity || d.tcgChecked) ? { ...c, ...d } : null; });
    const missing = list.filter((c, i) => !known[i]);
    if (missing.length > INDEX_BATCH) {
      await mapLimit(missing.slice(0, INDEX_BATCH), 8, c => details(kv, c));
      return { indexing: true, progress: { done: list.length - missing.length + INDEX_BATCH, total: list.length }, results: [] };
    }
    const read = await mapLimit(missing, 8, c => details(kv, c));
    let j = 0;
    cards = known.map(c => c || read[j++]);
  }
  let results = filterCards(cards, { ...p, set: null });
  if (p.set) {
    const extra = await unpublished(kv, p.set, cards.filter(c => c.set.toLowerCase() === p.set.toLowerCase()).map(c => c.number), p, ja);
    results = results.concat(extra).sort((a, b) => (a.number || 0) - (b.number || 0));
  } else if (ja) {
    for (const set of RECENT_SETS) {
      const inSet = await mapLimit(await resultList(kv, ja, set), 8, c => details(kv, c));
      results = (await unpublished(kv, set, inSet.map(c => c.number), p, ja)).concat(results);
    }
  }
  if (!results.length) return { query, results: [], message: p.set && !p.name && !list.length ? `Set « ${p.set} » introuvable.` : 'Aucune carte trouvée.' };
  const nUnpub = results.filter(c => c.unpublished).length;
  return {
    query, hits: list.length, results: results.slice(0, 60).map(decorate),
    note: nUnpub ? `${nUnpub} carte${nUnpub > 1 ? 's' : ''} pas encore publiée${nUnpub > 1 ? 's' : ''} par Pokémon (image indisponible) : ajoute ta photo pour l'utiliser.` : '',
  };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { kv } = require('@vercel/kv');

    // Photo d'une carte ajoutée à la main : publique (affichée aux clients lors des ouvertures)
    if (req.method === 'GET' && req.query.img) {
      const data = await kv.get('cards:img:' + String(req.query.img).slice(0, 60));
      if (!data) return res.status(404).end();
      const m = String(data).match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!m) return res.status(404).end();
      res.setHeader('Content-Type', m[1]);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(Buffer.from(m[2], 'base64'));
    }

    const code = req.headers['x-admin-code'];
    if (!code || code !== process.env.ADMIN_CODE) return res.status(403).json({ error: 'Accès refusé' });

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
        const id = String(c.cardId || '');
        if (!qty) return res.status(400).json({ error: 'Quantité requise' });
        let d;
        if (/^\d+$/.test(id)) {
          // Carte publiée : infos relues depuis la base officielle (cache), pas depuis le navigateur
          d = await details(kv, { cardId: id, name: cleanName(c.name).slice(0, 80), img: String(c.img || '') });
          if (!d.img.startsWith(OFFICIAL + '/assets/images/card_images/')) return res.status(400).json({ error: 'Image invalide' });
        } else {
          // Carte pas encore publiée : infos TCGdex + photo obligatoire
          const m = id.match(/^tcg-([A-Za-z0-9-]{1,12})-(\d{3})$/);
          if (!m) return res.status(400).json({ error: 'Carte invalide' });
          const t = await tcgdex('/cards/' + m[1] + '-' + m[2]);
          if (!t) return res.status(400).json({ error: 'Carte introuvable chez TCGdex' });
          const exists = cards.find(x => x.cardId === id);
          const img = String(body.imageData || '');
          if (!exists) {
            if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(img)) return res.status(400).json({ error: 'Ajoute une photo de la carte' });
            if (img.length > MAX_IMG * 1.37) return res.status(400).json({ error: 'Photo trop lourde' });
          }
          if (img) await kv.set('cards:img:' + id, img);
          const setInfo = await kv.get('cards:tcgset:' + m[1].toLowerCase());
          d = { cardId: id, name: t.name, set: m[1], number: +m[2], total: setInfo && setInfo.total, rarity: tcgRarity(t.rarity), img: '/api/cards?img=' + id };
        }
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
        if (card.cardId.startsWith('tcg-')) await kv.del('cards:img:' + card.cardId);
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
