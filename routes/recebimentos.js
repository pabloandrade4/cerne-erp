// Recebimentos (repasses de marketplace) — ativado em 24/08/2026 (ver
// docs/04-alteracoes.md). Tela somente leitura nesta etapa — ver
// lib/recebimentosMl.js pra regra completa e as premissas assumidas.
const express = require('express');
const { calcularPeriodo } = require('../lib/periodo');
const { listarRecebimentosMl } = require('../lib/recebimentosMl');

const router = express.Router();

// GET /api/recebimentos?empresaId=ID&periodo=30d
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const recebimentos = await listarRecebimentosMl({ empresaId, desde: periodoCalc.desde, ate: periodoCalc.ate });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      recebimentos,
    });
  } catch (err) { next(err); }
});

module.exports = router;
