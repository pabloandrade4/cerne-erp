// Aba "Performance de Anúncios" (Análise) — router fino, ver
// lib/performanceAnuncios.js para a regra de negócio.
const express = require('express');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const { gerarPerformanceAnuncios } = require('../lib/performanceAnuncios');

const router = express.Router();

// GET /api/performance-anuncios?empresaId=ID&periodo=30d&contaId=&sku=&status=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId, sku, status } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { ate: ateStr, desde: desdeStr } = periodoParaDatasBRT(periodoCalc);

    const resultado = await gerarPerformanceAnuncios({
      empresaId, contaId: contaId || null, sku: sku || null, status: status || null,
      periodoCalc, desdeStr, ateStr,
    });

    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
