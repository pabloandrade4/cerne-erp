// Ads da Shopee — 16/10/2026. Leitura sempre do banco (shopee_ads_diario);
// a sincronização roda em lib/shopeeAdsScheduler.js e pode ser forçada aqui.
const express = require('express');
const pool = require('../db/pool');
const { sincronizarAdsConta, resumoShopee, resumoUnificado } = require('../lib/shopeeAds');

const router = express.Router();

// GET /api/shopee-ads?empresaId=&periodo=30d
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, desde, ate } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    res.json(await resumoShopee({ empresaId: Number(empresaId), periodo, desde, ate }));
  } catch (err) { next(err); }
});

// GET /api/shopee-ads/unificado?empresaId=&periodo=30d — Mercado Livre + Shopee juntos
router.get('/unificado', async (req, res, next) => {
  try {
    const { empresaId, periodo, desde, ate } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    res.json(await resumoUnificado({ empresaId: Number(empresaId), periodo, desde, ate }));
  } catch (err) { next(err); }
});

// POST /api/shopee-ads/sincronizar  { empresaId }
router.post('/sincronizar', async (req, res, next) => {
  try {
    const empresaId = Number(req.body && req.body.empresaId);
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const { rows } = await pool.query(`SELECT id FROM shopee_contas WHERE empresa_id = $1 AND status = 'ativa'`, [empresaId]);
    const resultados = [];
    for (const r of rows) resultados.push(await sincronizarAdsConta(r.id).catch((e) => ({ contaId: r.id, ok: false, mensagem: e.message })));
    res.json({ resultados });
  } catch (err) { next(err); }
});

module.exports = router;
