// lib/vault-odds.js — Chances d'un pack mystère à partir du stock de cartes
// Même calcul que le calculateur de l'admin (onglet Cartes Vault) :
//   poids d'une carte = quantité × valeur^(-k) → plus elle est chère, plus elle est rare ;
//   k (0 à 3) est ajusté pour que la valeur moyenne d'une ouverture respecte la marge visée ;
//   la rareté « bonus » sort avec la probabilité fixée (bonusPct), la rareté garantie le reste du temps.

// Niveau d'éclat d'un lot (couleur de l'animation) selon sa valeur par rapport au prix du pack
function tierOf(value, price) {
  const r = value / (price || 1);
  if (r >= 8 || value >= 250) return 'legendary';
  if (r >= 2.5) return 'epic';
  if (r >= 1.2) return 'rare';
  if (r >= 0.75) return 'uncommon';
  return 'common';
}

function weighted(cards, bonusPct, k) {
  const B = cards.filter(c => c.tier === 'base'), S = cards.filter(c => c.tier === 'bonus');
  const w = c => c.qty * Math.pow(c.value, -k);
  const sB = B.reduce((a, c) => a + w(c), 0), sS = S.reduce((a, c) => a + w(c), 0);
  const b = S.length ? bonusPct / 100 : 0;
  return cards.map(c => ({ ...c, p: c.tier === 'base' ? (1 - b) * w(c) / sB : b * w(c) / sS }));
}
const evOf = rows => rows.reduce((a, c) => a + c.p * c.value, 0);

// stock : cartes de l'admin ; pack : réglage enregistré par le calculateur
function packOdds(stock, pack) {
  const base = pack.base || [], bonus = (pack.bonus || []).filter(r => !base.includes(r));
  const cards = (stock || [])
    .filter(c => c.qty > 0 && c.value > 0 && (base.includes(c.rarity) || bonus.includes(c.rarity)))
    .map(c => ({ ...c, tier: base.includes(c.rarity) ? 'base' : 'bonus' }));
  if (!cards.some(c => c.tier === 'base')) return { rows: [], ev: 0, k: 0, ok: false };
  const price = +pack.price || 0, bonusPct = +pack.bonusPct || 0;
  const fees = price * (+pack.feePct || 0) / 100 + (+pack.feeFix || 0);
  const target = price - fees - price * (+pack.margin || 0) / 100;
  let k = 0, rows = weighted(cards, bonusPct, 0);
  if (evOf(rows) > target) {
    let lo = 0, hi = 3;
    if (evOf(weighted(cards, bonusPct, hi)) > target) k = hi;
    else { for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; evOf(weighted(cards, bonusPct, m)) > target ? lo = m : hi = m; } k = hi; }
    rows = weighted(cards, bonusPct, k);
  }
  const ev = evOf(rows);
  return { rows: rows.map(c => ({ ...c, lot: tierOf(c.value, price) })), ev, k, ok: true, profit: price - fees - ev };
}

// Tirage d'une carte à partir d'un nombre [0,1)
function pickCard(rows, roll) {
  let acc = 0;
  for (const r of rows) { acc += r.p; if (roll < acc) return r; }
  return rows[rows.length - 1];
}

module.exports = { packOdds, pickCard, tierOf };
