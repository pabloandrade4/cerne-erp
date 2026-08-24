// Ads (Product Ads do Mercado Livre) — ativado em 25/08/2026. Ver
// lib/ads.js e lib/mlAds.js para o desenho completo (dado real quando a
// API permitir, nunca inventado).
const express = require('express');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const { listarAds } = require('../lib/ads');

const router = express.Router();

// GET /api/ads?empresaId=ID&periodo=30d&contaId=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { desde: desdeStr, ate: ateStr } = periodoParaDatasBRT(periodoCalc);

    const resultado = await listarAds({
      empresaId,
      contaId: contaId || null,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
      desdeStr,
      ateStr,
    });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      ...resultado,
    });
  } catch (err) { next(err); }
});

module.exports = router;
