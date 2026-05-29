# Eden Project TCG — Handoff (mai 2026)

Ce fichier documente l'historique complet des modifications effectuées sur le codebase,
les décisions prises, et le travail restant à faire.
Il est destiné à tout nouveau Claude qui reprend ce projet.

---

## Ce qui a été fait — Audit 1 (corrections sécurité critiques)

### 1. `api/capture-paypal-order.js` — CRÉÉ DE ZÉRO
**Problème** : Ce fichier n'existait pas. PayPal ne capturait jamais l'argent — les paiements
étaient approuvés par l'utilisateur mais jamais collectés (toutes les commandes PayPal étaient gratuites).

**Solution** : Endpoint POST `/api/capture-paypal-order` qui :
- Valide `orderId` (string, max 64 chars)
- Appelle `POST /v2/checkout/orders/{orderId}/capture` sur l'API PayPal
- Vérifie que `data.status === 'COMPLETED'` avant de répondre OK
- Retourne `{ ok, orderId, captureId, amount }`
- Idempotent via `PayPal-Request-Id: capture-${orderId}`

### 2. `api/create-paypal-order.js` — Refonte majeure
**Problème** : Utilisait une `BASE_PRICES` plate sans dégressivité, différente de Stripe.
Shipping non validé côté serveur.

**Solution** :
- Prix dégressifs identiques à Stripe
- Whitelist `VALID_SHIPPING = [0, 4.90, 7.90, 14.90]`
- Ship=0 uniquement avec code `SHIP0`
- Items limités à 50
- `PayPal-Request-Id` avec suffixe aléatoire
- Détection erreurs PayPal corrigée (`.name` au lieu de `.error`)

### 3. `api/create-payment.js` — Sécurité livraison
- Whitelist `VALID_SHIPPING` côté serveur
- Ship=0 requiert code `SHIP0`
- Erreurs Stripe sanitisées (message générique)
- Items cappés à 50
- `item.name` et `item.sub` slicés à 255 chars

### 4. `api/login.js` — Rate limiting
- Ajout IP rate limit : max 10 tentatives / 15 min
- Extraction IP depuis `x-forwarded-for`
- Dégradation gracieuse si KV indisponible

### 5. `api/register.js` — Sécurité inscription
- Validation email regex serveur-side
- Mot de passe minimum 8 chars (était 6)
- `id: usr_${randomUUID()}` via `crypto` natif Node 18
- bcrypt cost monté de 10 à 12
- Rate limit : 5 inscriptions / heure par IP
- Retourne HTTP 201

### 6. `api/admin.js` — Validation renforcée
- Validations strictes sur prix (0–10000), stocks (0–100000)
- Couleur hex regex `/^#[0-9a-fA-F]{6}$/`
- Labels ≤ 50 chars, codes ≤ 20 chars

### 7. `api/ebay-prices.js` — TTL natif
- `kv.set(cacheKey, avg, { ex: 3600 })` — expiration automatique Upstash
- Guard `queries.length > 30`
- Cache key cappé à 80 chars, term à 200 chars

### 8. `index.html` — 6 corrections

| # | Problème | Fix |
|---|---|---|
| 1 | `display:none` en double sur `#adminContent` | Suppression du doublon |
| 2 | Canvas rAF tourne même onglet masqué | Guard `document.hidden` + `visibilitychange` |
| 3 | Spin local fallback exploitable (spin gratuit sans serveur) | Fallback supprimé → message d'erreur |
| 4 | Total panier pas persisté avant redirect Stripe | `sessionStorage.setItem('eden_pending_total', ...)` |
| 5 | Admin panel s'ouvrait si API hors ligne (demo mode) | Fallback supprimé → message d'erreur |
| 6 | PayPal return sans capture | `checkReturn()` appelle `/api/capture-paypal-order` |

### 9. Animation lucioles — restaurée depuis le site live
Le fond canvas était absent du dossier local. Récupéré depuis `https://eden-project-tcg-hpw2.vercel.app`.
Lucioles dorées avec palette GOLD (4 ambrés + 2 foil rares), trail, halo radial, répulsion/attraction souris.

---

## Ce qui a été fait — Audit 2 (robustesse et architecture)

### 10. `lib/prices.js` — CRÉÉ (source unique)
- Centralise `BASE_PRICES`, `PROMO_CODES`, `PRIZE_CODES`, `VALID_SHIPPING`, `getServerPrice()`
- Élimine la duplication entre `create-payment.js` et `create-paypal-order.js`
- `getServerPrice(id, qty, adminPrices)` prend `adminPrices` en paramètre
  → permet un seul `kv.get` avant la boucle d'articles (fix N+1)

### 11. `lib/paypal.js` — CRÉÉ (source unique)
- Centralise `PAYPAL_BASE`, `PAYPAL_ENV`, `getPayPalToken()`
- Élimine la duplication entre `create-paypal-order.js` et `capture-paypal-order.js`

### 12. Fix N+1 appels KV dans les deux fichiers de paiement
**Problème** : `getServerPrice()` appelait `kv.get('admin:prices')` pour chaque article.
50 articles = 50 requêtes KV = ~2.5s de latence → timeout Vercel.

**Fix** : `kv.get('admin:prices')` appelé une seule fois avant la boucle,
résultat passé en paramètre à `getServerPrice(id, qty, adminPrices)`.

### 13. Fix `item.name.slice()` crash
**Problème** : `create-paypal-order.js` faisait `item.name.slice(0, 127)` sans vérifier le type.
Si le client envoyait `name: null` → `TypeError` non catchée → 500.

**Fix** : `String(item.name || '').slice(0, 127)` — identique à ce que Stripe faisait déjà.

### 14. Fix `BASE_PRICES` produit 7 divergent
**Problème** : Produit 7 avait 3 tiers dans `create-payment.js` mais seulement 1 dans `create-paypal-order.js`.

**Fix** : Unifié dans `lib/prices.js` avec 3 tiers (tous `p: null` — produit désactivé).

### 15. PRIZE_CODES — `BOOSTER` et `FREE_DISPLAY` tracés
**Problème** : Ces codes gagnés à la roue n'étaient pas reconnus dans les fichiers de paiement.
Résultat : code entré au checkout → 0% de réduction, pas d'alerte.

**Fix** : `PRIZE_CODES = new Set(['BOOSTER', 'FREE_DISPLAY'])` dans `lib/prices.js`.
Ces codes sont maintenant tracés dans les métadonnées Stripe (`metadata.prizeCode`)
et dans la description PayPal pour fulfillment manuel par Vincent.
Ils n'appliquent pas de réduction panier (ce sont des cadeaux physiques à expédier séparément).

### 16. Fix rate limiting — TTL toujours appliqué
**Problème** : `if (attempts === 1) await kv.expire(...)` — si `expire` échouait au 1er appel,
la clé n'expirait jamais → IP bannie définitivement.

**Fix** : `await kv.expire(ratKey, ...)` appelé sans condition (toujours reset).
Appliqué dans `login.js` et `register.js`.

### 17. Fix `winIndex` fallback dans `spin.js`
**Problème** : Si les probabilités de la wheel admin sommaient à < 100 (drift float),
`winIndex` restait à 0 ("Tentez encore") par défaut — biais discret.

**Fix** : `let winIndex = wheel.length - 1` — fallback sur le dernier segment.

### 18. Fix validation email Stripe
**Problème** : `customerEmail` non validé → si format invalide, Stripe rejetait la session → 500 générique.

**Fix** : Regex `EMAIL_RE` validée avant de passer à Stripe.

### 19. Fix `forgotLink` mort
**Problème** : Lien sans `href`, sans handler → clic sans effet.

**Fix** : `href="mailto:contact@edenprojecttcg.com?subject=Mot%20de%20passe%20oublié"`

---

## Backlog — Ce qu'il reste à faire

### Priorité haute

#### Webhook Stripe — `/api/stripe-webhook`
Actuellement `user.orders[]` n'est jamais rempli. Il n'y a aucune trace serveur des achats.
Pour le SAV, les remboursements, les confirmations email — il faut ce webhook.

```js
// Structure à créer
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
module.exports = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // kv.get(`user:${session.customer_email}`) → push order → kv.set
  }
  res.json({ received: true });
};
```

À ajouter dans `vercel.json` :
```json
{ "src": "/api/stripe-webhook", "dest": "/api/stripe-webhook" }
```

Ajouter `STRIPE_WEBHOOK_SECRET` dans les variables d'env Vercel.

#### Révocation JWT
Actuellement un token volé est valide 30 jours. Ajouter une `tokenVersion` dans l'objet user KV
et la valider dans chaque endpoint auth. Incrémenter `tokenVersion` au logout ou changement de mot de passe.

#### Reset mot de passe
Actuellement → mailto. Il faudrait un flow complet :
1. `POST /api/forgot-password` → génère token reset, stocke dans KV avec TTL 1h, envoie email (Resend/SendGrid)
2. `POST /api/reset-password` → valide token KV, met à jour hash bcrypt, supprime token

### Priorité moyenne

#### Historique commandes front
Le champ `user.orders[]` est dans le modèle KV mais jamais rempli.
Une fois le webhook Stripe en place, afficher l'historique dans le dashboard utilisateur.

#### Sélecteur Mondial Relay
Remplacer le bouton "Mondial Relay" par le widget officiel JS pour sélectionner un point relais.

#### Connexion domaine
Dans Vercel Dashboard → Domains → ajouter `edenprojecttcg.com`.
Configurer les DNS chez le registrar (CNAME ou A record).

### Priorité basse

#### i18n FR/EN
Ajouter un sélecteur de langue. Toutes les strings sont en dur dans le HTML.

#### Monitoring Stripe
Activer les alertes Stripe pour les paiements échoués et les disputes.

---

## Décisions techniques importantes

### Pourquoi `lib/` et pas `api/_shared.js` ?
Vercel expose tous les fichiers `api/*.js` comme endpoints HTTP.
Les fichiers dans `lib/` ne sont pas exposés — c'est la convention correcte.

### Pourquoi bcrypt cost 12 ?
Cost 10 était trop faible pour 2026 (brute-force GPU). Cost 12 ajoute ~200ms.
Les fonctions Vercel ont 1GB RAM — acceptable. Le JWT 30j réduit la fréquence des logins.

### Pourquoi JWT dans localStorage et pas httpOnly cookie ?
Simplicité côté SPA (pas de setup CSRF, pas de backend session).
Risque XSS accepté pour ce projet e-commerce simple.
Pour passer en cookie httpOnly : modifier tous les endpoints auth + ajouter middleware CORS credentials.

### Pourquoi `BOOSTER`/`FREE_DISPLAY` ne font pas de réduction panier ?
Ce sont des cadeaux physiques (booster pack ou display complète offerts).
Appliquer 100% de réduction au panier existant serait économiquement incohérent.
Le flow correct : l'utilisateur commande normalement, Vincent voit le `prizeCode` dans Stripe/PayPal
et expédie le cadeau séparément avec la commande.

### Produit 7 désactivé
Tous les tiers du produit 7 ont `p: null`. `getServerPrice` retourne `null` → article ignoré
dans le checkout. Si tu veux l'activer, mettre des prix dans les tiers dans `lib/prices.js`
ou via le panneau admin (override KV).

---

## Contexte GitHub

```bash
# Cloner
git clone https://github.com/edenprojectcompany-glitch/eden-project-tcg.git
cd eden-project-tcg

# Installer les dépendances
npm install

# Variables d'env locales
cp .env.example .env  # (créer ce fichier si besoin)
```

Le repo n'a pas de branche de dev — tout passe par `main` → Vercel auto-deploy.
**Ne jamais pusher sans confirmation explicite de Vincent.**

---

## Commits récents

```
6b5c4eb  fix: second audit — N+1 KV, item.name crash, shared lib, rate-limit TTL, spin fallback, forgotLink, PRIZE_CODES
0a6ddfd  fix: premier audit sécurité — PayPal capture, Stripe shipping whitelist, spin/admin exploits, lucioles canvas
```
