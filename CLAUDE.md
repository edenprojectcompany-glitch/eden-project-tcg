# Eden Project TCG — Documentation Claude (mise à jour mai 2026)

## Identité du projet
Marketplace e-commerce spécialisée dans les **displays Pokémon japonaises et chinoises**.
Site SPA (Single Page Application) hébergé sur Vercel avec APIs serverless Node.js.

---

## Repos & URLs

| | |
|---|---|
| **Repo principal (ce dossier)** | https://github.com/edenprojectcompany-glitch/eden-project-tcg |
| **Repo images catalogue** | https://github.com/edenprojectcompany-glitch/catalogue-pokemon |
| **URL prod actuelle** | https://eden-project-tcg-hpw2.vercel.app |
| **Domaine cible** | edenprojecttcg.com (à connecter dans Vercel) |
| **Stripe Dashboard** | https://dashboard.stripe.com |
| **PayPal Developer** | https://developer.paypal.com |

---

## Variables d'environnement requises (Vercel Dashboard)

| Variable | Description | Requis par |
|---|---|---|
| `STRIPE_SECRET_KEY` | Clé secrète Stripe (`sk_live_...`) | create-payment.js |
| `STRIPE_WEBHOOK_SECRET` | Signing secret webhook Stripe (`whsec_...`) ✅ configuré | stripe-webhook.js |
| `PAYPAL_CLIENT_ID` | Client ID PayPal | create-paypal-order.js, capture-paypal-order.js |
| `PAYPAL_CLIENT_SECRET` | Secret PayPal | create-paypal-order.js, capture-paypal-order.js |
| `PAYPAL_ENV` | `live` ou `sandbox` | create-paypal-order.js, capture-paypal-order.js |
| `EBAY_APP_ID` | App ID eBay | ebay-prices.js |
| `EBAY_CERT_ID` | Cert ID eBay | ebay-prices.js |
| `KV_REST_API_URL` | URL Upstash (auto-injecté si Vercel KV connecté) | tous sauf create-payment |
| `KV_REST_API_TOKEN` | Token Upstash (auto-injecté si Vercel KV connecté) | tous sauf create-payment |
| `JWT_SECRET` | Clé secrète JWT (chaîne aléatoire ≥ 32 chars) | login.js, register.js, spin.js |
| `ADMIN_CODE` | Code d'accès au panneau admin | admin.js |
| `SITE_URL` | URL du site sans slash final (`https://edenprojecttcg.com`) | CORS sur tous les endpoints |
| `BOXTAL_ACCESS_KEY` | Clé d'accès Boxtal API v1 | boxtal-order.js |
| `BOXTAL_SECRET_KEY` | Clé secrète Boxtal API v1 | boxtal-order.js |

> **Vercel KV** : créer une base dans le dashboard Vercel → Storage → KV, puis la connecter au projet. Les variables `KV_REST_API_URL` et `KV_REST_API_TOKEN` sont injectées automatiquement.

---

## Stack technique

```
Front-end   : HTML/CSS/JS vanilla (index.html — SPA)
Back-end    : Node.js 18+ serverless functions (Vercel)
Base KV     : Vercel KV (Upstash Redis)
Paiements   : Stripe Checkout + PayPal Orders v2
Auth        : JWT (jsonwebtoken) + bcryptjs (cost 12)
CI/CD       : GitHub → Vercel auto-deploy sur push main
```

---

## Structure des fichiers

```
/
├── index.html                    ← SPA complète (tout le front-end)
├── vercel.json                   ← Config routing + env vars documentées
├── package.json                  ← Dépendances Node
├── CLAUDE.md                     ← Ce fichier
├── HANDOFF.md                    ← Historique des modifications et backlog
├── lib/
│   ├── prices.js                 ← BASE_PRICES, PROMO_CODES, PRIZE_CODES, getServerPrice
│   └── paypal.js                 ← PAYPAL_BASE, getPayPalToken (partagés)
└── api/
    ├── admin.js                  ← Panel admin (prix/stocks/roue)
    ├── capture-paypal-order.js   ← Capture PayPal après approbation
    ├── create-payment.js         ← Stripe Checkout Session
    ├── create-paypal-order.js    ← PayPal Order création
    ├── ebay-prices.js            ← Prix eBay live + cache KV 1h
    ├── login.js                  ← Auth login → JWT
    ├── products.js               ← Prix/stocks overrides KV → front
    ├── register.js               ← Inscription → KV + JWT
    └── spin.js                   ← Roue de la fortune (cooldown 30j)
```

---

## APIs — Référence complète

### `POST /api/create-payment` — Stripe
```json
{
  "items": [{"id": 10, "name": "M2a Display", "sub": "JP", "qty": 2}],
  "shippingCost": 4.90,
  "promoCode": "EDEN10",
  "customerEmail": "user@email.com",
  "successUrl": "https://edenprojecttcg.com?payment=success",
  "cancelUrl": "https://edenprojecttcg.com?payment=cancel"
}
```
Retourne `{ url, sessionId }`.

### `POST /api/create-paypal-order` — PayPal
```json
{
  "items": [{"id": 10, "name": "M2a Display", "qty": 2}],
  "shippingCost": 4.90,
  "promoCode": "EDEN10"
}
```
Retourne `{ orderId, approveUrl }`.

### `POST /api/capture-paypal-order` — PayPal capture
```json
{ "orderId": "5O190127TN364715T" }
```
Retourne `{ ok, orderId, captureId, amount }`.

### `GET /api/products` — KV overrides
Retourne `{ prices: {id: prix}, stocks: {id: qty} }`. Cache edge 60s.

### `POST /api/ebay-prices` — Prix live
```json
{ "queries": [{"id": 10, "term": "Pokemon Mega Dream EX display JP"}] }
```
Retourne `{ prices: {10: 85} }`. Max 30 requêtes. Cache KV 1h.

### `POST /api/login`
```json
{ "email": "user@email.com", "password": "motdepasse" }
```
Retourne `{ token, user: {id, name, email, lastSpin, loyalty} }`. Rate limit : 10 tentatives / 15 min par IP.

### `POST /api/register`
```json
{ "name": "Vincent", "email": "user@email.com", "password": "motdepasse8+" }
```
Retourne `{ token, user }` avec HTTP 201. Rate limit : 5 inscriptions / heure par IP.

### `POST /api/spin` — Auth requise
Header : `Authorization: Bearer <jwt>`
Retourne `{ prize, winIndex, wheelConfig }`. Cooldown 30 jours par utilisateur.

### `GET/POST /api/admin` — Admin protégé
Header : `X-Admin-Code: <ADMIN_CODE>`
- GET : retourne `{ prices, stocks, wheel }`
- POST `set_prices` : met à jour les prix dans KV
- POST `set_stocks` : met à jour les stocks dans KV (clé `"0"` = stock Mystery Box, 0 = "Bientôt de retour")
- POST `set_wheel` : met à jour la roue (2–16 segments, somme probs = 100%)

### `GET /api/admin-users` — Admin protégé (onglet Clients)
Header : `X-Admin-Code: <ADMIN_CODE>`
Scanne toutes les clés `user:*` (via `kv.keys`) et retourne `{ users: [...] }` triés par date d'inscription décroissante. Chaque entrée : `{ id, name, email, createdAt, emailVerified, lastLoginAt, loginCount, loyalty, deliveryAddress, orders[], wonCodes[] }`. N'expose jamais le hash du mot de passe.

---

## Modèle de données KV (Upstash)

```
user:{email}          → { id, name, email, hash, createdAt, lastSpin, lastLoginAt, loginCount, orders[], wonCodes[], loyalty }
admin:prices          → { "10": 85, "11": 99, ... }   ← overrides prix par ID produit
admin:stocks          → { "0": 5, "10": 50, "11": 20, ... }   ← stocks par ID produit (ID 0 = Mystery Box)
admin:wheel           → [ { label, prob, code, color }, ... ]
ebay:{query_key}      → prix moyen (TTL 3600s natif Upstash)
ratelimit:login:{ip}  → compteur (TTL 900s)
ratelimit:register:{ip} → compteur (TTL 3600s)
```

---

## Catalogue — 22 produits

Images hébergées sur le repo images :
```
https://raw.githubusercontent.com/edenprojectcompany-glitch/catalogue-pokemon/main/img/{filename}
```

### Produits JP (IDs 10–22)
| ID | Nom | Fichier image |
|---|---|---|
| 10 | M2a — Méga Dream EX | mega-dream-ex-m2a.png |
| 11 | M2 — Méga Inferno X | inferno-x-m2.png |
| 12 | M1L — Méga Brave | mega-brave-m1l.png |
| 13 | M1s — Méga Symphonia | mega-symphonia-m1s.png |
| 14 | M3 — Nihil Zero | munikis-zero-m3.png |
| 15 | SV8a — Terastal Festival | terastal-fest-sv8a.png |
| 16 | SV9 — Battle Partners | battle-partners-sv9.png |
| 17 | SV9a — Heat Wave Arena | heat-wave-sv9a.png |
| 18 | SV10 — Glory Team Rocket | glory-rocket-sv10.png |
| 19 | SV11b — Black Bolt | black-bolt-sv11b.png |
| 20 | SV11w — White Flare | white-flare-sv11w.png |
| 21 | SV2a — Pokémon 151 | pokemon-151-sv2a.png |
| 22 | M5 — Mega Abyss Eye | abyss-eye-m5.png |

### Produits CN (IDs 1–9)
| ID | Nom | Fichier image |
|---|---|---|
| 1 | CN151 Vol.3 | 151c-vol3.png |
| 2 | CN151 Vol.4 | 151c-vol4.png |
| 3 | CN151 Vol.1 | 151c-vol1.png |
| 4 | CN151 Vol.2 | 151c-vol2.png |
| 5 | Gempack Vol.3 | gem-pack-vol3.png |
| 6 | Gempack Vol.2 | gem-pack-vol2.png |
| 7 | Gempack Vol.1 (désactivé — prix null) | gem-pack-vol1.png |
| 8 | Gempack Vol.4 | gem-pack-vol4.png |
| 9 | Gempack Vol.5 | gem-pack-vol5.png |

---

## Codes promo actifs

| Code | Réduction | Type |
|---|---|---|
| `EDEN5` | -5% panier | Discount |
| `EDEN10` | -10% panier | Discount |
| `EDEN20` | -20% panier | Discount |
| `WELCOME5` | -5% panier | Discount |
| `TCG15` | -15% panier | Discount |
| `SHIP0` | Livraison gratuite | Shipping |
| `BOOSTER` | Booster offert (fulfillment manuel) | Prix roue |
| `FREE_DISPLAY` | Display gratuite (fulfillment manuel) | Prix roue |

> `BOOSTER` et `FREE_DISPLAY` sont gagnés via la roue. Ils n'appliquent pas de réduction panier.
> Ils sont tracés dans les métadonnées Stripe/description PayPal pour expédition manuelle.

---

## Prix dégressifs (lib/prices.js)

Structure : `{ tiers: [{q: quantité_min, p: prix_unitaire}, ...] }`
Logique : pour chaque tier dont `qty >= q && p !== null`, le prix est mis à jour.
Le premier tier est le prix de base (quantité minimale).

Exemples :
- Produit 10 : 85€ (≥10), 80€ (≥20), 75€ (≥60)
- Produit 21 : 299€ (≥1), 295€ (≥12), 280€ (≥36)

Les overrides admin (KV `admin:prices`) prennent la priorité sur tous les tiers.

---

## Design system

### Typographie
- Titres : **Fraunces** (serif, Google Fonts)
- Corps : **Manrope** (sans-serif, Google Fonts)

### Palette CSS
```css
--obsidian: #0a0a0c        /* fond principal */
--obsidian-2: #111114      /* cartes */
--obsidian-3: #16161b
--glass: rgba(255,255,255,.04)
--glass-border: rgba(255,255,255,.09)
--foil-1: #7fd9ff          /* cyan */
--foil-2: #c9a8ff          /* violet */
--foil-3: #ffb3e6          /* rose */
--foil-4: #a8ffd4          /* vert menthe */
--success: #7fffaa
--danger: #ff7a7a
```

### Effets signature
- **Fond** : canvas 2D — animation lucioles dorées réactives à la souris
- **Cartes** : tilt 3D hover (GSAP) + reflet foil color-dodge
- **Nav** : glassmorphism `backdrop-filter: blur(28px)`
- **Animations** : `cubic-bezier(.16,1,.3,1)` (spring) partout
- **GSAP** 3.12.5 via CDN

### SPA — Navigation
`go(pageName)` pour naviguer. Pages disponibles :
`home`, `catalog`, `auth`, `dashboard`, `checkout`, `confirm`, `graded`, `news`

---

## Fonctionnalités front — état actuel

### ✅ Actif
- Catalogue 22 produits + filtres JP/CN + recherche live
- Modal produit avec prix dégressifs affichés
- Panier sidebar + calcul prix dégressifs client-side
- Livraison (Mondial Relay 4.90€ / Colissimo 7.90€ / Express 14.90€)
- Codes promo (réduction % et livraison gratuite)
- Paiement Stripe → `/api/create-payment`
- Paiement PayPal → `/api/create-paypal-order` + `/api/capture-paypal-order`
- Page confirmation avec confettis
- Auth utilisateur (inscription/connexion) → JWT stocké localStorage
- Dashboard utilisateur (points fidélité, roue de la fortune)
- Roue de la fortune → `/api/spin`
- Panneau admin protégé → `/api/admin`
- Prix eBay live → `/api/ebay-prices`
- Animation lucioles dorées (canvas 2D, réactive souris/touch)
- Mobile hamburger nav
- `visibilitychange` : pause canvas quand onglet caché

### ✅ Implémenté en audit 3 (mai 2026)
- Webhook Stripe (`/api/stripe-webhook`) → persistence commandes + points fidélité ✅
- Exit-intent popup WELCOME10 ✅
- Social proof : toast achats récents + badge "X regardent" ✅
- Trust signals dans checkout ✅
- Bug facturation auto-promo corrigé côté serveur ✅
- STRIPE_WEBHOOK_SECRET configuré dans Vercel + endpoint Stripe actif ✅

### ✅ Implémenté en audit 4 (juin 2026)
- Fix Mystery Box : fermée par défaut (stock id `0`), vérifiée côté serveur (Stripe + PayPal) et non plus seulement décorative côté front ✅
- Fix vérification stock manquante côté PayPal (`create-paypal-order.js` ne bloquait aucun produit en rupture avant ce correctif) ✅
- Panneau admin → onglet Produits : champ stock dédié Mystery Box ✅
- Panneau admin → nouvel onglet Clients (`/api/admin-users`) : connexions, achats, codes promo obtenus/utilisés par client ✅
- Traçabilité connexion (`lastLoginAt`, `loginCount`) ajoutée dans `api/login.js` ✅

### ❌ Pas encore implémenté (backlog)
- Historique commandes front (`user.orders[]` rempli par webhook mais pas affiché dans le dashboard)
- Révocation JWT (tokenVersion dans KV)
- Révocation JWT (logout serveur-side)
- Mécanisme reset mot de passe (actuellement → mailto)
- Sélecteur Mondial Relay (widget officiel)
- i18n FR/EN
- Connexion domaine `edenprojecttcg.com` dans Vercel

---

## Règle absolue
> Ne jamais pusher sur GitHub sans confirmation explicite de Vincent.

---

## Contact
- **Email propriétaire** : vincent.stalin@hotmail.fr / Edenprojectcompany@gmail.com
- **Support client site** : contact@edenprojecttcg.com
