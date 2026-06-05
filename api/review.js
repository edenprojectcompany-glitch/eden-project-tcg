// api/review.js — Système d'avis clients vérifiés
// POST /api/review { rating, text } + JWT → soumettre un avis (achat requis)
// GET /api/review → retourne les avis approuvés
// POST /api/review { action:'approve'|'reject', id } + X-Admin-Code → modération admin

const jwt = require('jsonwebtoken');
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Code');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { kv } = require('@vercel/kv');

    // ── GET : avis approuvés (public) ou tous les avis (admin) ──
    if (req.method === 'GET') {
      const reviews = await kv.get('reviews:list') || [];
      const adminCode = req.headers['x-admin-code'];
      if (adminCode && adminCode === process.env.ADMIN_CODE) {
        return res.status(200).json({ reviews });
      }
      const approved = reviews.filter(r => r.status === 'approved');
      return res.status(200).json({ reviews: approved });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      // ── Action admin (approve / reject) ──
      const adminCode = req.headers['x-admin-code'];
      if (adminCode) {
        if (adminCode !== process.env.ADMIN_CODE) return res.status(403).json({ error: 'Accès refusé' });
        const { action, id } = body;
        if (!['approve', 'reject', 'delete'].includes(action) || !id) {
          return res.status(400).json({ error: 'Paramètres invalides' });
        }
        const reviews = await kv.get('reviews:list') || [];
        const idx = reviews.findIndex(r => r.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Avis introuvable' });
        if (action === 'delete') {
          reviews.splice(idx, 1);
        } else {
          reviews[idx].status = action === 'approve' ? 'approved' : 'rejected';
        }
        await kv.set('reviews:list', reviews);
        return res.status(200).json({ ok: true });
      }

      // ── Soumission d'un avis (client connecté + achat vérifié) ──
      const authHeader = (req.headers['authorization'] || '').replace('Bearer ', '');
      if (!authHeader) return res.status(401).json({ error: 'Connexion requise' });

      let decoded;
      try { decoded = jwt.verify(authHeader, process.env.JWT_SECRET); }
      catch { return res.status(401).json({ error: 'Session expirée — reconnectez-vous' }); }

      // Vérifier que l'utilisateur a au moins une commande
      const user = await kv.get(`user:${decoded.email.toLowerCase().trim()}`);
      if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
      const orders = user.orders || [];
      if (orders.length === 0) {
        return res.status(403).json({ error: 'Vous devez avoir effectué un achat pour laisser un avis.' });
      }

      // Vérifier qu'il n'a pas déjà un avis en attente ou approuvé
      const existing = await kv.get('reviews:list') || [];
      const alreadyReviewed = existing.find(r =>
        r.email === decoded.email.toLowerCase().trim() &&
        ['pending', 'approved'].includes(r.status)
      );
      if (alreadyReviewed) {
        return res.status(409).json({ error: 'Vous avez déjà laissé un avis.' });
      }

      const { rating, text } = body;
      if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Note invalide (1-5)' });
      if (!text || typeof text !== 'string' || text.trim().length < 5 || text.length > 500) {
        return res.status(400).json({ error: 'Commentaire invalide (5-500 caractères)' });
      }

      const review = {
        id: `rv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: user.name || 'Client',
        email: decoded.email.toLowerCase().trim(),
        rating: parseInt(rating),
        text: text.trim(),
        status: 'pending',
        source: 'site',
        createdAt: new Date().toISOString(),
      };

      existing.unshift(review);
      await kv.set('reviews:list', existing);
      return res.status(201).json({ ok: true, message: 'Avis soumis, en attente de validation.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Review API error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
