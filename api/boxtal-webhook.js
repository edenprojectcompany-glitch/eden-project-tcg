// api/boxtal-webhook.js — Réception des callbacks Boxtal (bordereau + suivi)
// Boxtal appelle cette URL en GET avec différents paramètres selon le type de callback.
//
// Type "status" : bordereau prêt → label_url disponible
//   GET /api/boxtal-webhook?ref=EDN-XXX&type=status&emc_reference=...&carrier_reference=...&label_url=...
//   → met à jour la commande en KV + envoie l'email de suivi au client
//
// Type "tracking" : mise à jour du suivi
//   GET /api/boxtal-webhook?ref=EDN-XXX&type=tracking&etat=ENV&text=...&date=...
//   → met à jour le statut (LIV = livré → passe en "shipped")
//
// Réponse HTTP 200 = Boxtal considère le callback reçu.
// Réponse HTTP 422 = Boxtal considère la commande introuvable (il ne retentera pas).

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const { sendEmail, shippingTrackingHtml } = require('../lib/email');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Boxtal appelle en GET
  if (req.method !== 'GET') return res.status(405).end();

  const { ref, type, label_url, carrier_reference, emc_reference, etat, text, date } = req.query || {};

  // Référence Eden obligatoire
  if (!ref) return res.status(422).json({ error: 'ref manquante' });

  try {
    const { kv } = require('@vercel/kv');
    const orders  = await kv.get('orders:global') || [];
    const idx     = orders.findIndex(o => o.ref === ref);

    if (idx === -1) {
      console.warn(`boxtal-webhook : commande ${ref} introuvable`);
      return res.status(422).json({ error: 'Commande introuvable' });
    }

    const order = orders[idx];

    if (type === 'status') {
      // ── Bordereau prêt : on stocke l'URL du PDF et la référence transporteur ──
      if (label_url) {
        order.labelUrl       = label_url;
        order.carrierRef     = carrier_reference || order.carrierRef;
        order.boxtalRef      = emc_reference     || order.boxtalRef;
        order.status         = 'label_printed';
        order.labelPrintedAt = new Date().toISOString();
        console.log(`boxtal-webhook [status] ${ref} — bordereau reçu : ${label_url}`);

        // ── Email de suivi automatique au client ──────────────────────────────
        const clientEmail = order.customerEmail;
        const trackingNum = carrier_reference || order.carrierRef;
        if (clientEmail && trackingNum) {
          const trackingUrl = `https://www.chronopost.fr/tracking-colis/rechercheAvancee/${trackingNum}`;
          try {
            await sendEmail({
              to:      clientEmail,
              subject: `📦 Votre commande ${ref} est en route — n° ${trackingNum}`,
              html:    shippingTrackingHtml({
                ref,
                name:       order.customerName || '',
                carrierRef: trackingNum,
                trackingUrl,
              }),
            });
            console.log(`boxtal-webhook [email] tracking envoyé à ${clientEmail} pour ${ref}`);
          } catch (emailErr) {
            console.error(`boxtal-webhook [email] échec envoi tracking ${ref}:`, emailErr.message);
          }
        }
      }

    } else if (type === 'tracking') {
      // ── Mise à jour du suivi : on stocke le dernier statut transporteur ────────
      order.trackingStatus   = etat  || order.trackingStatus;
      order.trackingText     = text  || order.trackingText;
      order.trackingDate     = date  || order.trackingDate;

      // Si livré → on passe en "shipped"
      if (etat === 'LIV') {
        order.status    = 'shipped';
        order.shippedAt = new Date().toISOString();
        console.log(`boxtal-webhook [tracking] ${ref} — LIVRÉ`);
      } else {
        console.log(`boxtal-webhook [tracking] ${ref} — ${etat} : ${text}`);
      }
    }

    orders[idx] = order;
    await kv.set('orders:global', orders);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('boxtal-webhook error:', err.message);
    // On retourne 200 quand même pour que Boxtal ne retenante pas indéfiniment
    return res.status(200).json({ ok: false, error: err.message });
  }
};
