// lib/prices.js — Source de vérité unique pour les prix, promos et livraison
// Importé par create-payment.js et create-paypal-order.js

const BASE_PRICES = {
  1:  { tiers: [{ q: 10, p: 65 }, { q: 20, p: 60 }, { q: 60, p: 55 }] },
  2:  { tiers: [{ q: 10, p: 65 }, { q: 20, p: 60 }, { q: 60, p: 58 }] },
  3:  { tiers: [{ q: 10, p: 65 }, { q: 20, p: 55 }, { q: 60, p: 55 }] },
  4:  { tiers: [{ q: 10, p: 65 }, { q: 20, p: 60 }, { q: 60, p: 55 }] },
  5:  { tiers: [{ q: 10, p: 65 }, { q: 20, p: 60 }, { q: 60, p: 55 }] },
  6:  { tiers: [{ q: 10, p: 65 }, { q: 20, p: 60 }, { q: 60, p: 60 }] },
  7:  { tiers: [{ q: 10, p: null }, { q: 20, p: null }, { q: 60, p: null }] },
  8:  { tiers: [{ q: 10, p: 50 }, { q: 20, p: 45 }, { q: 60, p: 43 }] },
  9:  { tiers: [{ q: 10, p: 50 }, { q: 20, p: 45 }, { q: 60, p: 43 }] },
  10: { tiers: [{ q: 10, p: 85 }, { q: 20, p: 80 }, { q: 60, p: 75 }] },
  11: { tiers: [{ q: 6, p: 110 }, { q: 12, p: 105 }, { q: 36, p: 99 }] },
  12: { tiers: [{ q: 6, p: 89 },  { q: 12, p: 85 },  { q: 36, p: 79 }] },
  13: { tiers: [{ q: 6, p: 80 },  { q: 12, p: 75 },  { q: 36, p: 73 }] },
  14: { tiers: [{ q: 6, p: 80 },  { q: 12, p: 75 },  { q: 36, p: 73 }] },
  15: { tiers: [{ q: 10, p: 100 }, { q: 20, p: 95 }, { q: 60, p: 90 }] },
  16: { tiers: [{ q: 6, p: 80 },  { q: 12, p: 75 },  { q: 36, p: 73 }] },
  17: { tiers: [{ q: 6, p: 99 },  { q: 12, p: 95 },  { q: 36, p: 89 }] },
  18: { tiers: [{ q: 6, p: 130 }, { q: 12, p: 125 }, { q: 36, p: 120 }] },
  19: { tiers: [{ q: 6, p: 115 }, { q: 12, p: 110 }, { q: 36, p: 99 }] },
  20: { tiers: [{ q: 6, p: 110 }, { q: 12, p: 105 }, { q: 36, p: 99 }] },
  21: { tiers: [{ q: 1, p: 299 }, { q: 12, p: 295 }, { q: 36, p: 280 }] },
  22: { tiers: [{ q: 1, p: 120 }, { q: 12, p: 110 }, { q: 36, p: 105 }] },
};

// Codes promo réduction panier (en %)
const PROMO_CODES = { EDEN5: 5, EDEN10: 10, WELCOME5: 5, WELCOME10: 10, TCG15: 15, EDEN20: 20 };

// Remises automatiques dégressives (paliers de sous-total HT hors livraison)
const AUTO_PROMO_TIERS = [
  { min: 500, pct: 8 },
  { min: 300, pct: 5 },
  { min: 150, pct: 3 },
];

function getAutoPromoPct(subtotal) {
  for (const t of AUTO_PROMO_TIERS) {
    if (subtotal >= t.min) return t.pct;
  }
  return 0;
}

// Codes prix gagnés à la roue — fulfillment manuel, 0% de réduction panier
// Le code est tracé dans les métadonnées de la commande pour expédition séparée
const PRIZE_CODES = new Set(['BOOSTER', 'FREE_DISPLAY']);

const VALID_SHIPPING = [0, 4.90, 7.90, 14.90];

/**
 * Retourne le prix unitaire serveur pour un produit donné.
 * adminPrices doit être fetché UNE SEULE FOIS avant la boucle articles
 * et passé ici pour éviter N appels KV.
 */
function getServerPrice(id, qty, adminPrices) {
  const base = BASE_PRICES[id];
  if (!base) return null;

  if (adminPrices && adminPrices[id] != null) return adminPrices[id];

  let price = base.tiers[0].p;
  for (const t of base.tiers) {
    if (qty >= t.q && t.p !== null) price = t.p;
  }
  return price;
}

module.exports = { BASE_PRICES, PROMO_CODES, PRIZE_CODES, VALID_SHIPPING, AUTO_PROMO_TIERS, getServerPrice, getAutoPromoPct };
