// Contas a Receber — ativado em 24/08/2026 (ver docs/04-alteracoes.md).
// Router fino, mesmo padrão de routes/contasPagar.js — regra de negócio
// em lib/contasReceber.js.
const express = require('express');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const contasReceber = require('../lib/contasReceber');

const router = express.Router();

// GET /api/contas-receber?empresaId=ID&periodo=30d&status=a_receber|recebido|atrasado|cancelado&search=texto
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, status, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { desde, ate } = periodoParaDatasBRT(periodoCalc);

    const [contas, resumo] = await Promise.all([
      contasReceber.listarContasReceber({ empresaId, desde, ate, status, search }),
      contasReceber.resumoContasReceber({ empresaId, desde, ate }),
    ]);

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde, ate },
      contas,
      resumo,
    });
  } catch (err) { next(err); }
});

router.get('/origens-sugeridas', (req, res) => {
  res.json({ origens: contasReceber.ORIGENS_SUGERIDAS });
});

router.post('/', async (req, res, next) => {
  try {
    const result = await contasReceber.criarContaReceber(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.status(201).json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const result = await contasReceber.atualizarContaReceber(req.params.id, req.body);
    if (result.notFound) return res.status(404).json({ error: 'Conta a receber não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.patch('/:id/receber', async (req, res, next) => {
  try {
    const result = await contasReceber.marcarComoRecebido(req.params.id, req.body.dataRecebida);
    if (result.notFound) return res.status(404).json({ error: 'Conta a receber não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.patch('/:id/cancelar', async (req, res, next) => {
  try {
    const result = await contasReceber.cancelarContaReceber(req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Conta a receber não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await contasReceber.excluirContaReceber(req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Conta a receber não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
