// DRE — ativado em 24/08/2026. Router fino: toda a lógica mora em
// lib/dre.js (reaproveitando lib/relatorioVendas.js e lib/contasPagar.js,
// nada novo calculado aqui).
const express = require('express');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const { gerarDRE } = require('../lib/dre');

const router = express.Router();

// GET /api/dre?empresaId=ID&periodo=30d
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { desde: desdeBRT, ate: ateBRT } = periodoParaDatasBRT(periodoCalc);

    const dre = await gerarDRE({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
      desdeBRT,
      ateBRT,
    });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      dre,
    });
  } catch (err) { next(err); }
});

module.exports = router;
