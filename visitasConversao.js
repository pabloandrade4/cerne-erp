// Aba "Visitas e Conversão" (Análise) — router fino, ver
// lib/visitasConversao.js para a regra de negócio.
const express = require('express');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const { gerarVisitasConversao } = require('../lib/visitasConversao');

const router = express.Router();

// GET /api/visitas-conversao?empresaId=ID&periodo=30d&contaId=&sku=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId, sku } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { desde: desdeStr, ate: ateStr } = periodoParaDatasBRT(periodoCalc);

    const resultado = await gerarVisitasConversao({
      empresaId, contaId: contaId || null, sku: sku || null,
      periodoCalc, desdeStr, ateStr,
    });

    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
