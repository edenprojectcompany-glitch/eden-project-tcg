// api/mr-label.js — Génération étiquette Mondial Relay via API 1 (SOAP)
// Env requis : MR_KEY, ADMIN_CODE, KV_REST_API_URL, KV_REST_API_TOKEN

const crypto = require('crypto');
const https  = require('https');

const CORS_ORIGIN   = process.env.SITE_URL    || 'https://edenprojecttcg.com';
const MR_ENSEIGNE   = process.env.MR_ENSEIGNE || 'CC23K5TI';
const MR_SENDER     = {
  name : 'Eden Project TCG',
  ad2  : '',
  ville: 'BREST',
  cp   : '29200',
  pays : 'FR',
  tel  : '',
  mail : 'contact@edenprojecttcg.com',
};

/* ── Calcul clé de sécurité MD5 Mondial Relay ── */
// Règles confirmées par Claude Opus via WSDL officiel :
// - PAS de suppression d'espaces (valeurs telles qu'envoyées dans le XML)
// - PAS de toUpperCase sur l'input (seulement sur le hex en sortie)
// - Les valeurs des champs doivent être en MAJUSCULES à la source
function mrSecurity(values, privateKey) {
  const raw = values.map(v => String(v ?? '')).join('') + privateKey;
  return crypto.createHash('md5').update(raw).digest('hex').toUpperCase();
}

/* ── Appel SOAP ── */
function soapCall(xmlBody) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(xmlBody, 'utf-8');
    const opts = {
      hostname: 'api.mondialrelay.com',
      path    : '/WebService.asmx',
      method  : 'POST',
      headers : {
        'Content-Type'  : 'text/xml; charset=utf-8',
        'SOAPAction'    : '"http://www.mondialrelay.com/webservice/WSI2_CreationExpedition"',
        'Content-Length': buf.length,
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

/* ── Extraction valeur XML simple ── */
function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[^:>]*:)?${tag}[^>]*>([^<]*)<`));
  return m ? m[1].trim() : '';
}

/* ── Escape XML ── */
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminCode = req.headers['x-admin-code'];
  if (!adminCode || adminCode !== process.env.ADMIN_CODE) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const MR_KEY = process.env.MR_KEY;
  if (!MR_KEY) return res.status(500).json({ error: 'MR_KEY non configuré dans Vercel' });

  const { ref } = req.body || {};
  if (!ref || typeof ref !== 'string') return res.status(400).json({ error: 'Référence manquante' });

  try {
    const { kv } = require('@vercel/kv');
    const orders = await kv.get('orders:global') || [];
    const order  = orders.find(o => o.ref === ref);

    if (!order)              return res.status(404).json({ error: 'Commande introuvable' });
    if (order.shippingMode !== 'mr') return res.status(400).json({ error: 'Pas une commande Mondial Relay' });
    if (!order.mrPoint?.id) return res.status(400).json({ error: 'Point relais manquant sur cette commande' });

    // Valeurs en MAJUSCULES à la source (requis par l'API MR)
    const dest = {
      ad1  : esc((order.customerName || order.customerEmail || 'CLIENT').toUpperCase().slice(0, 32)),
      ville: esc((order.mrPoint.ville || '').toUpperCase()),
      cp   : esc(order.mrPoint.cp || ''),
      pays : 'FR',
      tel  : '',
      mail : esc(order.customerEmail || ''),
    };
    const livRel = esc(order.mrPoint.id);

    // Ordre EXACT du WSDL WSI2_CreationExpedition (confirmé par Claude Opus)
    // Champs inexistants supprimés : Montant, PUDHT, PUTTC
    // Champs ajoutés : Dest_Tel2, Longueur, Taille, Exp_Valeur, Exp_Devise, TReprise, Montage, Instructions
    const p = {
      Enseigne    : MR_ENSEIGNE,
      ModeCol     : 'CCC',
      ModeLiv     : '24R',
      NDossier    : '',
      NClient     : '',
      Expe_Langage: 'FR',
      Expe_Ad1    : MR_SENDER.name.toUpperCase(),
      Expe_Ad2    : MR_SENDER.ad2,
      Expe_Ad3    : '',
      Expe_Ad4    : '',
      Expe_Ville  : MR_SENDER.ville.toUpperCase(),
      Expe_CP     : MR_SENDER.cp,
      Expe_Pays   : MR_SENDER.pays,
      Expe_Tel1   : MR_SENDER.tel,
      Expe_Tel2   : '',
      Expe_Mail   : MR_SENDER.mail,
      Dest_Langage: 'FR',
      Dest_Ad1    : dest.ad1,
      Dest_Ad2    : '',
      Dest_Ad3    : '',
      Dest_Ad4    : '',
      Dest_Ville  : dest.ville,
      Dest_CP     : dest.cp,
      Dest_Pays   : dest.pays,
      Dest_Tel1   : dest.tel,
      Dest_Tel2   : '',
      Dest_Mail   : dest.mail,
      Poids       : '400',
      Longueur    : '',
      Taille      : '',
      NbColis     : '1',
      CRT_Valeur  : '0',
      CRT_Devise  : 'EUR',
      Exp_Valeur  : '0',
      Exp_Devise  : 'EUR',
      COL_Rel_Pays: '',
      COL_Rel     : '',
      LIV_Rel_Pays: 'FR',
      LIV_Rel     : livRel,
      TAvisage    : '',
      TReprise    : '',
      Montage     : '',
      TRDV        : '',
      Assurance   : '0',
      Instructions: '',
    };

    const security = mrSecurity(Object.values(p), MR_KEY);

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <WSI2_CreationExpedition xmlns="http://www.mondialrelay.com/webservice/">
      <Enseigne>${p.Enseigne}</Enseigne>
      <ModeCol>${p.ModeCol}</ModeCol>
      <ModeLiv>${p.ModeLiv}</ModeLiv>
      <NDossier>${p.NDossier}</NDossier>
      <NClient>${p.NClient}</NClient>
      <Expe_Langage>${p.Expe_Langage}</Expe_Langage>
      <Expe_Ad1>${p.Expe_Ad1}</Expe_Ad1>
      <Expe_Ad2>${p.Expe_Ad2}</Expe_Ad2>
      <Expe_Ad3>${p.Expe_Ad3}</Expe_Ad3>
      <Expe_Ad4>${p.Expe_Ad4}</Expe_Ad4>
      <Expe_Ville>${p.Expe_Ville}</Expe_Ville>
      <Expe_CP>${p.Expe_CP}</Expe_CP>
      <Expe_Pays>${p.Expe_Pays}</Expe_Pays>
      <Expe_Tel1>${p.Expe_Tel1}</Expe_Tel1>
      <Expe_Tel2>${p.Expe_Tel2}</Expe_Tel2>
      <Expe_Mail>${p.Expe_Mail}</Expe_Mail>
      <Dest_Langage>${p.Dest_Langage}</Dest_Langage>
      <Dest_Ad1>${p.Dest_Ad1}</Dest_Ad1>
      <Dest_Ad2>${p.Dest_Ad2}</Dest_Ad2>
      <Dest_Ad3>${p.Dest_Ad3}</Dest_Ad3>
      <Dest_Ad4>${p.Dest_Ad4}</Dest_Ad4>
      <Dest_Ville>${p.Dest_Ville}</Dest_Ville>
      <Dest_CP>${p.Dest_CP}</Dest_CP>
      <Dest_Pays>${p.Dest_Pays}</Dest_Pays>
      <Dest_Tel1>${p.Dest_Tel1}</Dest_Tel1>
      <Dest_Tel2>${p.Dest_Tel2}</Dest_Tel2>
      <Dest_Mail>${p.Dest_Mail}</Dest_Mail>
      <Poids>${p.Poids}</Poids>
      <Longueur>${p.Longueur}</Longueur>
      <Taille>${p.Taille}</Taille>
      <NbColis>${p.NbColis}</NbColis>
      <CRT_Valeur>${p.CRT_Valeur}</CRT_Valeur>
      <CRT_Devise>${p.CRT_Devise}</CRT_Devise>
      <Exp_Valeur>${p.Exp_Valeur}</Exp_Valeur>
      <Exp_Devise>${p.Exp_Devise}</Exp_Devise>
      <COL_Rel_Pays>${p.COL_Rel_Pays}</COL_Rel_Pays>
      <COL_Rel>${p.COL_Rel}</COL_Rel>
      <LIV_Rel_Pays>${p.LIV_Rel_Pays}</LIV_Rel_Pays>
      <LIV_Rel>${p.LIV_Rel}</LIV_Rel>
      <TAvisage>${p.TAvisage}</TAvisage>
      <TReprise>${p.TReprise}</TReprise>
      <Montage>${p.Montage}</Montage>
      <TRDV>${p.TRDV}</TRDV>
      <Assurance>${p.Assurance}</Assurance>
      <Instructions>${p.Instructions}</Instructions>
      <Security>${security}</Security>
    </WSI2_CreationExpedition>
  </soap:Body>
</soap:Envelope>`;

    const soapResp = await soapCall(xml);
    console.log('[mr-label] SOAP response:', soapResp.slice(0, 500));

    const stat = xmlVal(soapResp, 'STAT');
    if (stat !== '0') {
      console.error('[mr-label] MR error STAT=' + stat, soapResp);
      // Extraire le message d'erreur SOAP si présent
      const faultString = xmlVal(soapResp, 'faultstring') || xmlVal(soapResp, 'Message') || '';
      const detail = stat ? `code ${stat}` : (faultString || 'réponse inattendue');
      return res.status(400).json({ error: `Erreur Mondial Relay (${detail}) — vérifiez les paramètres de votre compte`, debug: soapResp.slice(0, 800) });
    }

    const expedition = xmlVal(soapResp, 'ExpeditionNum');
    if (!expedition) return res.status(500).json({ error: 'Numéro d\'expédition non reçu' });

    const labelUrl = `https://www.mondialrelay.com/ww2/PDF/etiquette.aspx?expedition=${expedition}&codeEns=${MR_ENSEIGNE}`;

    // Mise à jour KV : statut + numéro d'expédition
    const idx = orders.findIndex(o => o.ref === ref);
    if (idx !== -1) {
      orders[idx].status         = 'label_printed';
      orders[idx].labelPrintedAt = new Date().toISOString();
      orders[idx].mrExpedition   = expedition;
      orders[idx].mrLabelUrl     = labelUrl;
      await kv.set('orders:global', orders);
    }

    return res.status(200).json({ ok: true, expedition, labelUrl });
  } catch (err) {
    console.error('[mr-label] error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
};
