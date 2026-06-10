// lib/prices.js — Source de vérité unique pour les prix, promos et livraison
// Importé par create-payment.js et create-paypal-order.js

const BASE_PRICES = {
  0:  { tiers: [{ q: 1, p: 249 }] }, // Mystery Box — prix fixe, pas de dégressif
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

// Codes réservés à la première commande — compte obligatoire, 0 order existant
const FIRST_ORDER_CODES = new Set(['WELCOME10', 'WELCOME5']);

// Codes réservés à la roue — ne peuvent être utilisés que si l'utilisateur les a gagnés
// minAmount : sous-total minimum (hors livraison) pour pouvoir utiliser le code
const WHEEL_ONLY_CODES = {
  SHIP0:       { minAmount: 50 },
  BOOSTER:     { minAmount: 0  },
  FREE_DISPLAY:{ minAmount: 0  },
  EDEN5:       { minAmount: 0  },
  EDEN10:      { minAmount: 0  },
  EDEN20:      { minAmount: 0  },
  TCG15:       { minAmount: 0  },
};

const VALID_SHIPPING = [0, 4.90, 7.90, 14.90];

// Catégorie langue par ID produit (pour le palier groupé)
// Les produits de même langue mutualisent leur quantité pour les paliers
const PRODUCT_LANG = {
  0:'mystery', 1:'cn',2:'cn',3:'cn',4:'cn',5:'cn',6:'cn',7:'cn',8:'cn',9:'cn',
  10:'jp',11:'jp',12:'jp',13:'jp',14:'jp',15:'jp',16:'jp',17:'jp',
  18:'jp',19:'jp',20:'jp',21:'jp',22:'jp',
};

/**
 * Calcule les quantités groupées par langue à partir d'une liste d'items.
 * items: [{ id, qty }]
 * Retourne { cn: N, jp: N }
 */
function computeLangPools(items) {
  const pools = { cn: 0, jp: 0 };
  for (const item of items) {
    const lang = PRODUCT_LANG[item.id];
    if (lang && pools[lang] !== undefined) pools[lang] += parseInt(item.qty) || 0;
  }
  return pools;
}

// Cases disponibles — JP : 12 displays/case · CN : 20 displays/case · +150€ logistique
// Doit rester synchronisé avec CASE_CATALOG dans index.html
const CASE_CATALOG = [
  { id: 18, qty: 12, basePrice: 125 }, // SV10 — Glory Rocket    JP  125×12+150=1650€
  { id: 11, qty: 12, basePrice: 105 }, // M2 — Méga Inferno X    JP  105×12+150=1410€
  { id: 15, qty: 20, basePrice: 95 },  // SV8a — Terastal Fest   JP   95×20+150=2050€
  { id: 10, qty: 20, basePrice: 80 },  // M2a — Méga Dream EX    JP   80×20+150=1750€
  { id: 2,  qty: 20, basePrice: 60 },  // CN151 Vol.4            CN   60×20+150=1350€
  { id: 1,  qty: 20, basePrice: 60 },  // CN151 Vol.3            CN   60×20+150=1350€
  { id: 21, qty: 12, basePrice: 295 }, // SV2a — Pokémon 151     JP  295×12+150=3690€
  { id: 22, qty: 12, basePrice: 110 }, // M5 — Mega Abyss Eye    JP  110×12+150=1470€
];
const CASE_SURCHARGE = 150;

/**
 * Retourne le prix total (€) d'une case pour un produit donné.
 * Indépendant du prix marketplace (adminPrices[id]) — les cases scellées ont leur propre tarif.
 * Priorité : override admin direct sur la case (admin:prices['case_'+id])
 *            → sinon prix catalogue de base × qty + surcharge.
 */
function getCasePrice(id, adminPrices) {
  const caseInfo = CASE_CATALOG.find(c => c.id === id);
  if (!caseInfo) return null;
  const override = adminPrices && adminPrices['case_' + id];
  if (override != null) return +override;
  return +(caseInfo.basePrice * caseInfo.qty + CASE_SURCHARGE).toFixed(2);
}

/**
 * Retourne le prix unitaire serveur pour un produit donné.
 * pooledQty : quantité totale de la langue du produit dans le panier (palier groupé).
 *             Si null/undefined, utilise qty individuelle.
 */
function getServerPrice(id, qty, adminPrices, pooledQty) {
  const base = BASE_PRICES[id];
  if (!base) return null;

  if (adminPrices && adminPrices[id] != null) return adminPrices[id];

  // Utilise la quantité poolée si disponible, sinon la quantité individuelle
  const effectiveQty = (pooledQty != null && pooledQty > qty) ? pooledQty : qty;

  let price = base.tiers[0].p;
  for (const t of base.tiers) {
    if (effectiveQty >= t.q && t.p !== null) price = t.p;
  }
  return price;
}

module.exports = { BASE_PRICES, PROMO_CODES, PRIZE_CODES, FIRST_ORDER_CODES, WHEEL_ONLY_CODES, VALID_SHIPPING, AUTO_PROMO_TIERS, PRODUCT_LANG, getServerPrice, getAutoPromoPct, computeLangPools, CASE_CATALOG, CASE_SURCHARGE, getCasePrice };
