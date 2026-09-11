// Faturamento — ativado em 24/08/2026. Router fino: toda a lógica mora em
// lib/faturamento.js.
const express = require('express');
const { calcularPeriodo } = require('../lib/periodo');
const faturamento = require('../lib/faturamento');

const router = express.Router();

// GET /api/faturamento?empresaId=ID&periodo=30d&status=&search=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, status, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { itens, totalNoPeriodo } = await faturamento.listarFaturamento({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
      status,
      search,
    });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      itens,
      totalNoPeriodo,
    });
  } catch (err) { next(err); }
});

// PATCH /api/faturamento/:pedidoId/situacao  { status, observacao }
router.patch('/:pedidoId/situacao', async (req, res, next) => {
  try {
    const result = await faturamento.atualizarSituacao(req.params.pedidoId, req.body || {});
    if (result.notFound) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ situacao: result.situacao });
  } catch (err) { next(err); }
});

// PATCH /api/faturamento/lote  { pedidoIds: [...], status }
router.patch('/lote', async (req, res, next) => {
  try {
    const { pedidoIds, status } = req.body || {};
    const result = await faturamento.atualizarSituacaoEmLote(pedidoIds, status);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
