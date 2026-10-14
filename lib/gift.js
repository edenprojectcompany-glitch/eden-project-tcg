// lib/gift.js — Booster cadeau (remplace la roue de la fortune depuis le 14/10/2026)
// Règles communes à /api/spin (ancienne roue) et à /api/vault (ouverture dans la chambre forte) :
//   - débloqué après un premier achat ;
//   - un booster par mois (< 1 500 € d'achats), par semaine (≥ 1 500 €), par jour (≥ 5 000 €) ;
//   - chaque code gagné est à usage unique et valable 30 jours.
// Les chances sont réglables dans l'admin (clé KV admin:gift) ; sinon DEFAULT_GIFT.

const DEFAULT_GIFT = [
  { label: '-5 % (max 15 €)',            prob: 65, code: 'EDEN5',   color: '#7fd9ff' },
  { label: 'Livraison offerte dès 50 €', prob: 20, code: 'SHIP0',   color: '#a8ffd4' },
  { label: '-10 € dès 80 €',             prob: 10, code: 'MOINS10', color: '#c9a8ff' },
  { label: 'Booster offert dès 50 €',    prob: 5,  code: 'BOOSTER', color: '#ffd97f' },
];
const CODE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const totalSpent = user => (user.orders || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0);
const cooldownOf = user => { const s = totalSpent(user); return s >= 5000 ? DAY : s >= 1500 ? 7 * DAY : 30 * DAY; };

// { eligible, reason, nextAt, cooldownMs }
function giftStatus(user, now = Date.now()) {
  if (!user.orders || user.orders.length === 0) return { eligible: false, reason: 'first-order', nextAt: null, cooldownMs: cooldownOf(user) };
  const cooldownMs = cooldownOf(user);
  const next = user.lastSpin ? new Date(user.lastSpin).getTime() + cooldownMs : 0;
  return { eligible: now >= next, reason: now >= next ? null : 'cooldown', nextAt: next > now ? new Date(next).toISOString() : null, cooldownMs };
}

// Réglage admin valide (somme 100) sinon réglage par défaut
async function giftTable(kv) {
  const raw = await kv.get('admin:gift');
  if (Array.isArray(raw) && raw.length && Math.abs(raw.reduce((s, x) => s + (+x.prob || 0), 0) - 100) < .01) return raw;
  return DEFAULT_GIFT;
}

// Tirage à partir d'un nombre [0,1)
function pickGift(table, roll) {
  let acc = 0;
  for (const seg of table) { acc += seg.prob / 100; if (roll < acc) return seg; }
  return table[table.length - 1];
}

// Enregistre le gain sur le compte (code à usage unique, 30 jours) — l'appelant sauvegarde l'utilisateur
function awardGift(user, prize, now = Date.now()) {
  user.lastSpin = new Date(now).toISOString();
  user.wonCodes = user.wonCodes || [];
  const won = { code: prize.code, label: prize.label, wonAt: new Date(now).toISOString(), expiresAt: new Date(now + CODE_DAYS * DAY).toISOString(), used: false, reserved: false, via: 'gift' };
  user.wonCodes.push(won);
  if (user.wonCodes.length > 30) user.wonCodes = user.wonCodes.slice(-30);
  return won;
}

// Un code gagné est-il encore utilisable ? (les anciens codes sans date restent valables)
const wonCodeValid = (w, now = Date.now()) => !w.expiresAt || new Date(w.expiresAt).getTime() > now;

module.exports = { DEFAULT_GIFT, CODE_DAYS, giftStatus, giftTable, pickGift, awardGift, wonCodeValid };
