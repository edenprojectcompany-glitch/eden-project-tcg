// lib/email.js — Utilitaire email via Resend (https://resend.com)
// Env requis : RESEND_API_KEY
// Env optionnel : RESEND_FROM (défaut : Eden Project TCG <contact@edenprojecttcg.com>)
// Ajouter RESEND_API_KEY dans Vercel Dashboard → Environment Variables

const RESEND_API = 'https://api.resend.com/emails';
const FROM = process.env.RESEND_FROM || 'Eden Project TCG <contact@edenprojecttcg.com>';
const ADMIN_EMAIL = 'contact@edenprojecttcg.com';
const SITE_URL = process.env.SITE_URL || 'https://edenprojecttcg.com';

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY manquant — email non envoyé:', subject);
    return;
  }
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, html }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[email] Resend error:', err);
    } else {
      console.log('[email] Envoyé:', subject, '→', to);
    }
  } catch (err) {
    console.error('[email] sendEmail failed:', err.message);
  }
}

function orderConfirmationHtml({ ref, name, amount, items, provider }) {
  const itemRows = (items || []).map(i =>
    `<tr><td style="padding:6px 0;color:#c0c0c8">${escHtml(i.name ?? i.n ?? '')}</td><td style="padding:6px 0;text-align:right;color:#f4f4f6">${escHtml(i.qty ?? i.q ?? '')} × ${escHtml(i.unitPrice ?? i.p ?? '')}€</td></tr>`
  ).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0a0a0c;font-family:Manrope,Arial,sans-serif;margin:0;padding:40px 20px">
<div style="max-width:540px;margin:0 auto;background:#111114;border-radius:20px;border:1px solid rgba(255,255,255,.08);overflow:hidden">
  <div style="padding:32px 36px;background:linear-gradient(135deg,rgba(127,217,255,.08),rgba(201,168,255,.06))">
    <div style="font-size:22px;font-weight:600;color:#f4f4f6;margin-bottom:4px">Eden Project <span style="color:#7fd9ff">TCG</span></div>
    <div style="font-size:13px;color:#8a8a93">Marketplace Pokémon Premium · Brest, France</div>
  </div>
  <div style="padding:32px 36px">
    <h2 style="font-size:24px;font-weight:500;color:#f4f4f6;margin:0 0 8px">✅ Commande confirmée</h2>
    <p style="color:#8a8a93;font-size:14px;margin:0 0 24px">Bonjour ${escHtml(name) || 'Collectionneur'}, votre paiement a bien été reçu.</p>
    <div style="background:#16161b;border-radius:12px;padding:20px;margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.06)">
        <span style="color:#8a8a93;font-size:12px;text-transform:uppercase;letter-spacing:.1em">Référence</span>
        <span style="color:#7fd9ff;font-weight:700;font-family:monospace">${ref}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px">
        <span style="color:#8a8a93;font-size:12px;text-transform:uppercase;letter-spacing:.1em">Montant</span>
        <span style="color:#a8ffd4;font-weight:700;font-size:18px">${parseFloat(amount||0).toFixed(2).replace('.',',')} €</span>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span style="color:#8a8a93;font-size:12px;text-transform:uppercase;letter-spacing:.1em">Paiement</span>
        <span style="color:#f4f4f6">${provider === 'paypal' ? 'PayPal' : 'Carte bancaire (Stripe)'}</span>
      </div>
    </div>
    <div style="background:#16161b;border-radius:12px;padding:20px;margin-bottom:24px">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#8a8a93;margin-bottom:12px">📦 Récapitulatif</div>
      <p style="color:#8a8a93;font-size:13px;margin:0">Votre commande est en cours de préparation depuis notre entrepôt à Brest. Vous recevrez un email de suivi dès l'expédition.</p>
    </div>
    <div style="text-align:center;margin-bottom:24px">
      <a href="${SITE_URL}?page=dashboard" style="display:inline-block;background:linear-gradient(135deg,#7fd9ff,#c9a8ff);color:#0a0a0c;font-weight:700;padding:14px 32px;border-radius:100px;text-decoration:none;font-size:14px">Voir mon espace client</a>
    </div>
    <div style="border-top:1px solid rgba(255,255,255,.06);padding-top:20px;color:#5a5a63;font-size:12px;line-height:1.6">
      Des questions ? Répondez à cet email ou écrivez à <a href="mailto:contact@edenprojecttcg.com" style="color:#7fd9ff">contact@edenprojecttcg.com</a><br>
      Eden Project TCG · Brest, France · <a href="${SITE_URL}" style="color:#7fd9ff">edenprojecttcg.com</a>
    </div>
  </div>
</div>
</body></html>`;
}

function adminOrderHtml({ ref, customerEmail, customerName, amount, provider, promoCode, prizeCode }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0a0a0c;font-family:Arial,sans-serif;padding:30px">
<div style="max-width:500px;background:#111114;border-radius:16px;padding:24px;border:1px solid #333">
  <h2 style="color:#7fd9ff;margin:0 0 16px">🛒 Nouvelle commande reçue</h2>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="color:#8a8a93;padding:5px 0">Référence</td><td style="color:#f4f4f6;font-weight:700">${escHtml(ref)}</td></tr>
    <tr><td style="color:#8a8a93;padding:5px 0">Client</td><td style="color:#f4f4f6">${escHtml(customerName)||'—'} &lt;${escHtml(customerEmail)||'—'}&gt;</td></tr>
    <tr><td style="color:#8a8a93;padding:5px 0">Montant</td><td style="color:#a8ffd4;font-weight:700;font-size:18px">${parseFloat(amount||0).toFixed(2)} €</td></tr>
    <tr><td style="color:#8a8a93;padding:5px 0">Paiement</td><td style="color:#f4f4f6">${provider==='paypal'?'PayPal':'Stripe'}</td></tr>
    ${promoCode?`<tr><td style="color:#8a8a93;padding:5px 0">Code promo</td><td style="color:#c9a8ff">${escHtml(promoCode)}</td></tr>`:''}
    ${prizeCode?`<tr><td style="color:#8a8a93;padding:5px 0">⚠️ Prix roue</td><td style="color:#ff7a7a;font-weight:700">${escHtml(prizeCode)} — FULFILLMENT REQUIS</td></tr>`:''}
  </table>
</div>
</body></html>`;
}

function resetPasswordHtml({ name, resetUrl }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0a0a0c;font-family:Manrope,Arial,sans-serif;margin:0;padding:40px 20px">
<div style="max-width:480px;margin:0 auto;background:#111114;border-radius:20px;border:1px solid rgba(255,255,255,.08);overflow:hidden">
  <div style="padding:32px 36px;background:linear-gradient(135deg,rgba(127,217,255,.08),rgba(201,168,255,.06))">
    <div style="font-size:22px;font-weight:600;color:#f4f4f6">Eden Project <span style="color:#7fd9ff">TCG</span></div>
  </div>
  <div style="padding:32px 36px">
    <h2 style="font-size:22px;color:#f4f4f6;margin:0 0 12px">🔑 Réinitialisation du mot de passe</h2>
    <p style="color:#8a8a93;font-size:14px;margin:0 0 24px">Bonjour ${escHtml(name)||'Collectionneur'},<br>Cliquez sur le bouton ci-dessous pour définir un nouveau mot de passe. Ce lien est valable <strong style="color:#f4f4f6">1 heure</strong>.</p>
    <div style="text-align:center;margin-bottom:28px">
      <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#7fd9ff,#c9a8ff);color:#0a0a0c;font-weight:700;padding:14px 32px;border-radius:100px;text-decoration:none;font-size:14px">Réinitialiser mon mot de passe</a>
    </div>
    <div style="background:#16161b;border-radius:10px;padding:14px;margin-bottom:20px">
      <div style="font-size:11px;color:#5a5a63;word-break:break-all">${resetUrl}</div>
    </div>
    <p style="color:#5a5a63;font-size:12px">Si vous n'avez pas demandé cette réinitialisation, ignorez cet email. Votre mot de passe ne sera pas modifié.</p>
  </div>
</div>
</body></html>`;
}

function verifyEmailHtml({ name, verifyUrl }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#0a0a0c;font-family:Arial,sans-serif;margin:0;padding:40px 16px">
<div style="max-width:520px;margin:0 auto">
  <!-- Header -->
  <div style="text-align:center;margin-bottom:32px">
    <div style="font-size:26px;font-weight:700;color:#f4f4f6;letter-spacing:-.5px">Eden Project <span style="color:#f0c060">TCG</span></div>
    <div style="font-size:12px;color:#6a6a73;margin-top:4px;letter-spacing:.12em;text-transform:uppercase">Marketplace Pokémon Premium</div>
  </div>
  <!-- Card -->
  <div style="background:#111114;border-radius:24px;border:1px solid rgba(240,192,96,.2);overflow:hidden">
    <!-- Top bar -->
    <div style="height:4px;background:linear-gradient(90deg,#f0c060,#c9a8ff,#7fd9ff)"></div>
    <div style="padding:40px 36px">
      <!-- Icon -->
      <div style="text-align:center;font-size:52px;margin-bottom:20px">✉️</div>
      <h1 style="margin:0 0 10px;font-size:24px;font-weight:700;color:#f4f4f6;text-align:center;line-height:1.25">Confirme ton adresse e-mail</h1>
      <p style="margin:0 0 28px;font-size:15px;color:#8a8a93;text-align:center;line-height:1.6">Bonjour <strong style="color:#f4f4f6">${escHtml(name)}</strong>,<br>clique sur le bouton ci-dessous pour activer ton compte et débloquer ton code <span style="color:#f0c060;font-weight:700">WELCOME10</span>.</p>
      <!-- CTA -->
      <div style="text-align:center;margin-bottom:28px">
        <a href="${escHtml(verifyUrl)}" style="display:inline-block;background:linear-gradient(135deg,#d4a020,#f0c060);color:#0a0a0c;text-decoration:none;font-weight:800;font-size:15px;padding:17px 40px;border-radius:14px;letter-spacing:.02em">✦ Confirmer mon adresse</a>
      </div>
      <!-- Code teaser -->
      <div style="background:rgba(240,192,96,.07);border:1px solid rgba(240,192,96,.2);border-radius:14px;padding:16px 20px;text-align:center;margin-bottom:24px">
        <div style="font-size:11px;color:#8a8a93;letter-spacing:.15em;text-transform:uppercase;margin-bottom:6px">Ton cadeau de bienvenue</div>
        <div style="font-family:monospace;font-size:26px;font-weight:800;color:#f0c060;letter-spacing:.1em">WELCOME10</div>
        <div style="font-size:12px;color:#6a6a73;margin-top:4px">-10% sur ta première commande · sans minimum</div>
      </div>
      <!-- Expiry note -->
      <p style="font-size:12px;color:#5a5a63;text-align:center;margin:0 0 8px">Ce lien est valable <strong style="color:#8a8a93">24 heures</strong>.</p>
      <p style="font-size:11px;color:#4a4a53;text-align:center;margin:0">Si tu n'as pas créé de compte, ignore cet email.</p>
    </div>
  </div>
  <!-- Footer -->
  <div style="text-align:center;margin-top:28px">
    <p style="font-size:11px;color:#4a4a53;margin:0">Eden Project TCG · contact@edenprojecttcg.com</p>
    <p style="font-size:11px;color:#3a3a43;margin:6px 0 0"><a href="${escHtml(SITE_URL)}" style="color:#6a6a73;text-decoration:none">www.edenprojecttcg.com</a></p>
  </div>
</div>
</body></html>`;
}

module.exports = { sendEmail, orderConfirmationHtml, adminOrderHtml, resetPasswordHtml, verifyEmailHtml, ADMIN_EMAIL, SITE_URL };
