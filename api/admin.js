// api/admin.js — Panneau admin sécurisé (prix, stocks, roue)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, ADMIN_CODE

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const code = req.headers['x-admin-code'];
  if (!code || code !== process.env.ADMIN_CODE) {
    // Rate limiting sur les tentatives échouées : 10 / 15 min par IP
    // Fail-closed : si KV est indisponible, on bloque plutôt que de laisser passer sans compter
    try {
      const { kv } = require('@vercel/kv');
      const ip = (req.headers['x-vercel-forwarded-for'] || '').trim() || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const ratKey = `ratelimit:admin:${ip}`;
      const attempts = await kv.incr(ratKey);
      await kv.expire(ratKey, 900);
      if (attempts > 10) {
        return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
      }
    } catch (kvErr) {
      // KV indisponible → fail-closed : on ne peut pas garantir le rate-limit, on bloque
      console.error('Admin rate-limit KV error (fail-closed):', kvErr.message);
      return res.status(429).json({ error: 'Service temporairement indisponible. Réessayez dans quelques instants.' });
    }
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    const { kv } = require('@vercel/kv');

    if (req.method === 'GET') {
      const [prices, stocks, wheel, flashsale, shipping, graded] = await Promise.all([
        kv.get('admin:prices'),
        kv.get('admin:stocks'),
        kv.get('admin:wheel'),
        kv.get('admin:flashsale'),
        kv.get('admin:shipping'),
        kv.get('admin:graded'),
      ]);
      return res.status(200).json({
        prices: prices || {},
        stocks: stocks || {},
        wheel: wheel || null,
        flashsale: flashsale || {},
        shipping: shipping || { relay: 4.90, colissimo: 7.90, express: 14.90, freeForAll: false },
        graded: graded || null,
      });
    }

    if (req.method === 'POST') {
      const { action, data } = req.body || {};

      if (action === 'set_prices') {
        if (typeof data !== 'object' || Array.isArray(data)) {
          return res.status(400).json({ error: 'Format invalide' });
        }
        // Reset complet si demandé
        if (data.__reset === true) {
          await kv.set('admin:prices', {});
          return res.status(200).json({ ok: true, reset: true });
        }
        // Lire les prix existants pour merger (ne pas écraser les clés case_X)
        const existing = await kv.get('admin:prices') || {};
        // Nettoyer les clés invalides héritées d'anciens bugs
        const validated = Object.fromEntries(Object.entries(existing).filter(([k]) => k !== 'NaN' && k !== 'undefined'));
        for (const [k, v] of Object.entries(data)) {
          const price = parseFloat(v);
          if (!isNaN(price) && price >= 0 && price <= 10000) {
            // Préserver les clés "case_X" telles quelles, convertir les numériques
            const key = k.startsWith('case_') ? k : String(parseInt(k));
            if (key !== 'NaN') validated[key] = +price.toFixed(2);
          }
        }
        await kv.set('admin:prices', validated);
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_stocks') {
        if (typeof data !== 'object' || Array.isArray(data)) {
          return res.status(400).json({ error: 'Format invalide' });
        }
        // Reset complet si demandé
        if (data.__reset === true) {
          await kv.set('admin:stocks', {});
          return res.status(200).json({ ok: true, reset: true });
        }
        // Lire les stocks existants pour merger (ne pas écraser les clés case_X)
        const existing = await kv.get('admin:stocks') || {};
        // Nettoyer les clés invalides héritées d'anciens bugs
        const validated = Object.fromEntries(Object.entries(existing).filter(([k]) => k !== 'NaN' && k !== 'undefined'));
        for (const [k, v] of Object.entries(data)) {
          const stock = parseInt(v);
          if (!isNaN(stock) && stock >= 0 && stock <= 100000) {
            // Préserver les clés "case_X" telles quelles, convertir les numériques
            const key = k.startsWith('case_') ? k : String(parseInt(k));
            if (key !== 'NaN') validated[key] = stock;
          }
        }
        await kv.set('admin:stocks', validated);
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_flashsale') {
        if (typeof data !== 'object' || Array.isArray(data)) {
          return res.status(400).json({ error: 'Format invalide' });
        }
        const validated = {};
        for (const [k, v] of Object.entries(data)) {
          const id = parseInt(k);
          if (isNaN(id)) continue;
          validated[id] = {
            active: !!v.active,
            salePrice: v.salePrice != null ? +parseFloat(v.salePrice).toFixed(2) : null,
            endTime: v.endTime ? parseInt(v.endTime) : null,
          };
        }
        await kv.set('admin:flashsale', validated);
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_wheel') {
        if (!Array.isArray(data) || data.length < 2 || data.length > 16) {
          return res.status(400).json({ error: 'Format roue invalide' });
        }
        const total = data.reduce((s, p) => s + (parseFloat(p.prob) || 0), 0);
        if (Math.abs(total - 100) > 0.1) {
          return res.status(400).json({ error: `Probabilités = ${total.toFixed(1)}% (doit être 100%)` });
        }
        const validated = data.map(p => ({
          label: String(p.label).slice(0, 50),
          prob: +(parseFloat(p.prob).toFixed(2)),
          code: p.code ? String(p.code).slice(0, 20) : null,
          color: /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#1a1a28',
        }));
        await kv.set('admin:wheel', validated);
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_shipping') {
        const relay = parseFloat(data?.relay);
        const colissimo = parseFloat(data?.colissimo);
        const express = parseFloat(data?.express);
        const outremer = parseFloat(data?.outremer ?? 20);
        if ([relay, colissimo, express].some(v => isNaN(v) || v < 0 || v > 100)) {
          return res.status(400).json({ error: 'Tarifs invalides (0–100€)' });
        }
        if (isNaN(outremer) || outremer < 0 || outremer > 200) {
          return res.status(400).json({ error: 'Tarif outre-mer invalide (0–200€)' });
        }
        await kv.set('admin:shipping', {
          relay: +relay.toFixed(2),
          colissimo: +colissimo.toFixed(2),
          express: +express.toFixed(2),
          outremer: +outremer.toFixed(2),
          freeForAll: data?.freeForAll === true,
        });
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_graded') {
        if (!Array.isArray(data) || data.length !== 4) {
          return res.status(400).json({ error: '4 cartes requises' });
        }
        const validated = data.map(c => ({
          name: String(c.name || '').slice(0, 60),
          sub: String(c.sub || '').slice(0, 80),
          tag: String(c.tag || '').slice(0, 60),
          price: c.price != null && !isNaN(parseFloat(c.price)) ? +parseFloat(c.price).toFixed(2) : null,
          badge: String(c.badge || '').slice(0, 30),
          available: !!c.available,
        }));
        await kv.set('admin:graded', validated);
        return res.status(200).json({ ok: true });
      }

      if (action === 'export_colissimo_csv') {
        const orders = await kv.get('orders:global') || [];
        // Commandes en attente avec adresse + mode Colissimo ou Express
        const toExport = orders.filter(o =>
          o.shippingAddress &&
          ['colissimo','express','exp','dom','outremer'].includes((o.shippingMode||'').toLowerCase()) &&
          o.status !== 'shipped'
        );

        if (!toExport.length) {
          return res.status(200).json({ ok: true, csv: '', count: 0 });
        }

        // Format officiel ColiShip (gabarit Colissimo) — séparateur ; | poids en kg virgule | CRLF Windows
        // Raison sociale;Nom;Prénom;Adresse1;Adresse2;CP;Commune;Pays;Portable;Téléphone;Mail;Poids;Code PR;Contre sig;Assurance
        const SEP = ';';
        const CRLF = '\r\n';
        const POIDS_PAR_DISPLAY_KG = 0.5; // kg par display (FMT ModeleImport.FMT = KG)

        const rows = toExport.map(o => {
          const a = o.shippingAddress;
          const fullName = (a.name || o.customerName || '').trim().toUpperCase();
          const spIdx = fullName.indexOf(' ');
          const nom    = spIdx > 0 ? fullName.slice(spIdx + 1) : fullName;
          const prenom = spIdx > 0 ? fullName.slice(0, spIdx) : '';
          const nbDisplays = (o.items || []).reduce((s, i) => s + (parseInt(i.q) || 1), 0) || 1;
          const poidsKg = (nbDisplays * POIDS_PAR_DISPLAY_KG).toFixed(2).replace('.', ',');
          const contreSignature = (o.shippingMode||'').toLowerCase() === 'express' ? 'O' : 'N';
          const clean = v => String(v || '').replace(/;/g, ',').trim();

          // Format ModeleImport.FMT officiel ColiShip — 15 colonnes, poids en KG
          // EXP = identifiant interne ColiShip (pas dans le CSV, géré par EntetLigneColis)
          return [
            '',                                      // col1  RaisonSociale
            clean(nom),                              // col2  NomDestinataire
            clean(prenom),                           // col3  Prénom
            clean(a.line1),                          // col4  Adresse1
            clean(a.line2 || ''),                    // col5  Adresse4 (complément)
            clean(a.postal_code),                    // col6  CodePostal
            clean(a.city).toUpperCase(),             // col7  Commune
            clean(a.country || 'FR').toUpperCase(), // col8  CodePays
            clean(a.tel || ''),                      // col9  Portable
            '',                                      // col10 Telephone fixe
            clean(a.email || o.customerEmail || ''),// col11 Mail
            poidsKg,                                 // col12 Poids (KG virgule)
            '',                                      // col13 CodePointRetrait
            contreSignature,                         // col14 LivraisonAvecSignature O/N
            '',                                      // col15 MontantADV (assurance)
          ].join(SEP);
        });

        const csv = rows.join(CRLF) + CRLF;
        return res.status(200).json({ ok: true, csv, count: toExport.length });
      }

      if (action === 'update_order_status') {
        const { ref, status } = data || {};
        if (!ref || !status) return res.status(400).json({ error: 'ref et status requis' });
        const orders = await kv.get('orders:global') || [];
        const idx = orders.findIndex(o => o.ref === ref);
        if (idx === -1) return res.status(404).json({ error: 'Commande introuvable' });
        orders[idx].status = String(status).slice(0, 20);
        if (status === 'shipped' && data.trackingNumber) {
          orders[idx].trackingNumber = String(data.trackingNumber).slice(0, 50);
          orders[idx].shippedAt = new Date().toISOString();
        }
        await kv.set('orders:global', orders);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Action inconnue' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
