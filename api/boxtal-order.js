// api/boxtal-order.js — Création d'expéditions Boxtal v1 depuis l'admin Eden
// Env requis : ADMIN_CODE, KV_REST_API_URL, KV_REST_API_TOKEN
// Env requis : BOXTAL_ACCESS_KEY, BOXTAL_SECRET_KEY, SITE_URL
//
// Flux :
//  1. Pour chaque commande pending sélectionnée, appel GET /cotation Boxtal
//  2. Sélection de l'offre la moins chère compatible avec le mode d'envoi client
//  3. Appel POST /order Boxtal → création de l'expédition
//  4. Sauvegarde de la référence Boxtal dans orders:global (KV)
//  5. Boxtal rappellera /api/boxtal-webhook avec l'URL du bordereau quand il sera prêt

const https = require('https');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const BOXTAL_BASE = 'https://www.envoimoinscher.com/api/v1';

// ── Infos expéditeur fixes Eden Project ───────────────────────────────────────
const EDEN = {
  type:        'entreprise',
  societe:     'Eden Project',
  prenom:      'Vincent',
  nom:         'Stalin',
  adresse:     '20 rue Louis le Guen de Kerangall',
  code_postal: '29200',
  ville:       'Brest',
  pays:        'FR',
  email:       'edenprojectcompany@gmail.com',
  tel:         '33619180433', // format international sans +
};

// ── Paramètres colis par défaut (displays Pokémon scellées) ──────────────────
const CODE_CONTENU         = '80100'; // Produits culturels : jeux, cartes Pokémon (Boxtal code vérifié)
const POIDS_PAR_DISPLAY_KG = 0.45;   // kg par display
const LONGUEUR_CM          = 20;
const LARGEUR_CM           = 15;
const HAUTEUR_CM           = 5;

// ── Mapping mode d'envoi Eden → service Boxtal (codes exacts vérifiés via API) ─
// operator CHRP = Chronopost. Les deux services déposent à La Poste bureau Rue Siam Brest.
const SERVICE_MAP = {
  'shop2shop': { operator: 'CHRP', service: 'Chrono2ShopDirect' }, // Éco relais — dépôt bureaude poste, retrait relais Chronopost, ~J+2
  'relais13':  { operator: 'CHRP', service: 'ChronoRelais'       }, // J+1 garanti — dépôt bureau de poste, retrait relais Chronopost
};

// ── Helpers CORS ─────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
}

// ── En-tête Basic Auth Boxtal ─────────────────────────────────────────────────
function boxtalAuth() {
  const ak = process.env.BOXTAL_ACCESS_KEY || '';
  const sk = process.env.BOXTAL_SECRET_KEY || '';
  if (!ak || !sk) throw new Error('BOXTAL_ACCESS_KEY / BOXTAL_SECRET_KEY manquants dans les variables Vercel');
  return 'Basic ' + Buffer.from(`${ak}:${sk}`).toString('base64');
}

// ── Requête GET vers l'API Boxtal (retourne status + body texte) ──────────────
function boxtalGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path.startsWith('http') ? path : `${BOXTAL_BASE}${path}`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'Authorization': boxtalAuth(), 'Accept': 'application/xml' },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Requête POST vers l'API Boxtal (params en query string, body vide) ────────
function boxtalPost(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path.startsWith('http') ? path : `${BOXTAL_BASE}${path}`);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Authorization':  boxtalAuth(),
        'Accept':         'application/xml',
        'Content-Length': 0,
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Extraction simple de valeur XML (première occurrence du tag) ──────────────
function xmlVal(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1].trim() : '';
}

// ── Extraction de tous les blocs d'un tag XML ─────────────────────────────────
function xmlAll(xml, tag) {
  const re  = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// ── Parse les offres de cotation XML → tableau d'objets ──────────────────────
function parseOffers(xml) {
  return xmlAll(xml, 'offer').map(block => {
    const opBlock  = xmlVal(block, 'operator');
    const svcBlock = xmlVal(block, 'service');
    const delBlock = xmlVal(block, 'delivery');
    const typeBlk  = xmlVal(delBlock, 'type');
    const priceBlk = xmlVal(block, 'price');
    return {
      operatorCode:    xmlVal(opBlock,  'code'),
      operatorLabel:   xmlVal(opBlock,  'label'),
      serviceCode:     xmlVal(svcBlock, 'code'),
      serviceLabel:    xmlVal(svcBlock, 'label'),
      deliveryType:    xmlVal(typeBlk,  'code'),   // PICKUP_POINT | HOME | COMPANY
      prixTTC:         parseFloat(xmlVal(priceBlk, 'tax-inclusive') || '9999'),
    };
  }).filter(o => o.operatorCode && !isNaN(o.prixTTC));
}

// ── Sélection de la meilleure offre selon le mode d'envoi client ──────────────
// shippingMode : 'mr' | 'colissimo' | 'dom' | 'express' | 'exp'
function selectOffer(offers, shippingMode) {
  const isMR      = shippingMode === 'mr';
  const isExpress = ['express', 'exp'].includes(shippingMode || '');

  let pool;
  if (isMR) {
    // Le client veut un point relais → on prend les offres PICKUP_POINT
    pool = offers.filter(o => o.deliveryType === 'PICKUP_POINT');
  } else if (isExpress) {
    // Express → livraison domicile, offres rapides (pas relais)
    pool = offers.filter(o => o.deliveryType !== 'PICKUP_POINT');
  } else {
    // Colissimo / dom → livraison domicile ou entreprise
    pool = offers.filter(o => o.deliveryType !== 'PICKUP_POINT');
  }

  // Fallback : si aucun filtre ne matche, on prend tout
  if (!pool.length) pool = offers;

  // Tri par prix TTC croissant → offre la moins chère
  pool.sort((a, b) => a.prixTTC - b.prixTTC);
  return pool[0] || null;
}

// ── Cotation pour une commande ─────────────────────────────────────────────────
async function getCotation(order) {
  const a       = order.shippingAddress || {};
  const nbItems = (order.items || []).reduce((s, i) => s + (parseInt(i.q || i.qty) || 1), 0) || 1;
  const poids   = (nbItems * POIDS_PAR_DISPLAY_KG).toFixed(3);

  const params = new URLSearchParams({
    'colis_0.poids':    poids,
    'colis_0.longueur': LONGUEUR_CM,
    'colis_0.largeur':  LARGEUR_CM,
    'colis_0.hauteur':  HAUTEUR_CM,
    'code_contenu':     CODE_CONTENU,
    'expediteur.pays':        EDEN.pays,
    'expediteur.code_postal': EDEN.code_postal,
    'expediteur.ville':       EDEN.ville,
    'expediteur.type':        EDEN.type,
    'destinataire.pays':        a.country      || 'FR',
    'destinataire.code_postal': a.postal_code  || '',
    'destinataire.ville':       a.city         || '',
    'destinataire.type':        'particulier',
  });

  const resp = await boxtalGet(`/cotation?${params.toString()}`);
  if (resp.status !== 200) throw new Error(`Cotation HTTP ${resp.status} : ${resp.body.slice(0, 200)}`);
  return resp.body;
}

// ── Création commande Boxtal ───────────────────────────────────────────────────
async function createOrder(order, offer, siteUrl) {
  const a       = order.shippingAddress || {};
  const nbItems = (order.items || []).reduce((s, i) => s + (parseInt(i.q || i.qty) || 1), 0) || 1;
  const poids   = (nbItems * POIDS_PAR_DISPLAY_KG).toFixed(3);

  // Découpage prénom / nom depuis le nom complet du destinataire
  const fullName  = (a.name || order.customerName || '').trim();
  const spaceIdx  = fullName.indexOf(' ');
  const prenomDest = spaceIdx > 0 ? fullName.slice(0, spaceIdx)  : fullName || 'Client';
  const nomDest   = spaceIdx > 0 ? fullName.slice(spaceIdx + 1) : 'Eden';

  // Date de collecte = aujourd'hui (ou demain si > 17h)
  const now     = new Date();
  const collecte = now.toISOString().slice(0, 10);

  // URL de callback unique par commande : Boxtal l'appelle quand le bordereau est prêt
  const urlPush = `${siteUrl}/api/boxtal-webhook?ref=${encodeURIComponent(order.ref)}`;

  const params = new URLSearchParams({
    // ── Colis
    'colis_0.poids':     poids,
    'colis_0.longueur':  LONGUEUR_CM,
    'colis_0.largeur':   LARGEUR_CM,
    'colis_0.hauteur':   HAUTEUR_CM,
    'colis.description': 'Displays Pokémon scellées',
    'code_contenu':      CODE_CONTENU,
    // ── Collecte
    'collecte': collecte,
    // ── Expéditeur Eden
    'expediteur.type':        EDEN.type,
    'expediteur.prenom':      EDEN.prenom,
    'expediteur.nom':         EDEN.nom,
    'expediteur.societe':     EDEN.societe,
    'expediteur.email':       EDEN.email,
    'expediteur.tel':         EDEN.tel,
    'expediteur.adresse':     EDEN.adresse,
    'expediteur.pays':        EDEN.pays,
    'expediteur.code_postal': EDEN.code_postal,
    'expediteur.ville':       EDEN.ville,
    // ── Destinataire
    'destinataire.type':        'particulier',
    'destinataire.prenom':      prenomDest,
    'destinataire.nom':         nomDest,
    'destinataire.email':       order.customerEmail || '',
    'destinataire.tel':         a.tel || '33600000000', // fallback si non collecté
    'destinataire.adresse':     a.line1 || '',
    'destinataire.pays':        a.country      || 'FR',
    'destinataire.code_postal': a.postal_code  || '',
    'destinataire.ville':       a.city         || '',
    // ── Transporteur sélectionné par la cotation
    'operator': offer.operatorCode,
    'service':  offer.serviceCode,
    // ── Callback Boxtal → Eden
    'url_push':          urlPush,
    'reference_externe': order.ref,
  });

  // Point relais Chronopost choisi par le client pendant le checkout
  if (order.chronoPoint?.code) {
    params.set('retrait.pointrelais', order.chronoPoint.code);
  }
  // Rétrocompatibilité : ancien mode MR (commandes historiques)
  else if (order.shippingMode === 'mr' && order.mrPoint?.id) {
    params.set('retrait.pointrelais', order.mrPoint.id);
  }

  const resp = await boxtalPost(`/order?${params.toString()}`);
  return resp;
}

// ── Handler principal ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Vérification admin
  const code = req.headers['x-admin-code'];
  if (!code || code !== process.env.ADMIN_CODE) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { refs } = req.body || {}; // tableau de refs à traiter (ex: ['EDN-ABC123'])
  const siteUrl = process.env.SITE_URL || 'https://edenprojecttcg.com';

  try {
    const { kv } = require('@vercel/kv');
    const allOrders = await kv.get('orders:global') || [];

    // Si refs fournis → seulement ces commandes, sinon → toutes les pending
    const toProcess = refs && refs.length
      ? allOrders.filter(o => refs.includes(o.ref))
      : allOrders.filter(o => o.status === 'pending' && o.shippingAddress && o.shippingMode !== 'mr' ||
                               o.status === 'pending' && o.shippingAddress);

    if (!toProcess.length) {
      return res.status(200).json({ ok: true, results: [], message: 'Aucune commande à traiter' });
    }

    const results = [];

    for (const order of toProcess) {
      const result = { ref: order.ref, customerName: order.customerName, status: null, error: null };

      try {
        // 1. Résolution du service Boxtal depuis le mode d'envoi Eden
        const mapped = SERVICE_MAP[order.shippingMode] || SERVICE_MAP['shop2shop'];
        const offer  = {
          operatorCode:  mapped.operator,
          operatorLabel: 'Chronopost',
          serviceCode:   mapped.service,
          serviceLabel:  order.shippingMode === 'relais13' ? 'Chrono Relais 13' : 'Chrono 2Shop Direct',
          prixTTC:       null, // sera connu après création
        };

        result.offer = {
          operator: offer.operatorLabel,
          service:  offer.serviceLabel,
          prixTTC:  offer.prixTTC,
        };

        // 3. Création de la commande Boxtal
        const orderResp = await createOrder(order, offer, siteUrl);

        if (orderResp.status !== 200) {
          // Boxtal retourne XML ou JSON selon le type d'erreur
          let errMsg = '';
          try {
            const parsed = JSON.parse(orderResp.body);
            errMsg = parsed.message || JSON.stringify(parsed);
          } catch {
            errMsg = xmlVal(orderResp.body, 'message') || orderResp.body.slice(0, 300);
          }
          // Message actionnable si 403
          if (orderResp.status === 403) {
            errMsg = 'Paiement différé non activé sur ce compte Boxtal → appeler le 3631 pour activation';
          }
          result.status = 'error';
          result.error  = `Boxtal HTTP ${orderResp.status} : ${errMsg}`;
          results.push(result);
          continue;
        }

        // 4. Extraire la référence Boxtal de la réponse
        const boxtalRef = xmlVal(orderResp.body, 'reference');
        result.status    = 'created';
        result.boxtalRef = boxtalRef;

        // 5. Mettre à jour la commande dans KV
        const idx = allOrders.findIndex(o => o.ref === order.ref);
        if (idx !== -1) {
          allOrders[idx].boxtalRef       = boxtalRef;
          allOrders[idx].boxtalCreatedAt = new Date().toISOString();
          allOrders[idx].boxtalOffer     = result.offer;
          allOrders[idx].status          = 'label_printed'; // le bordereau arrive via webhook
        }

      } catch (err) {
        result.status = 'error';
        result.error  = err.message;
      }

      results.push(result);
    }

    // Sauvegarder les modifications en KV une seule fois (batch)
    await kv.set('orders:global', allOrders);

    const created = results.filter(r => r.status === 'created').length;
    const errors  = results.filter(r => r.status === 'error' || r.status === 'no_offer').length;

    return res.status(200).json({ ok: true, results, created, errors });

  } catch (err) {
    console.error('boxtal-order error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
};
