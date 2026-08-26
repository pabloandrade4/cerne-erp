// Despesas Fixas — ativado em 25/08/2026 (ver docs/04-alteracoes.md).
// Router fino: toda a regra de negócio mora em lib/despesasFixas.js, mesmo
// padrão de lib/contasPagar.js/lib/contasReceber.js.
const express = require('express');
const despesasFixas = require('../lib/despesasFixas');
const { obterStatusGeracaoDespesasFixas } = require('../lib/despesasFixasScheduler');

const router = express.Router();

// GET /api/despesas-fixas?empresaId=ID&ativo=true|false
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, ativo } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const despesas = await despesasFixas.listarDespesasFixas({ empresaId, ativo });
    res.json({
      despesas,
      geracaoAutomatica: obterStatusGeracaoDespesasFixas(),
    });
  } catch (err) { next(err); }
});

router.get('/categorias-sugeridas', (req, res) => {
  res.json({ categorias: despesasFixas.CATEGORIAS_SUGERIDAS });
});

router.post('/', async (req, res, next) => {
  try {
    const result = await despesasFixas.criarDespesaFixa(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.status(201).json({ despesa: result.despesa });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const result = await despesasFixas.atualizarDespesaFixa(req.params.id, req.body);
    if (result.notFound) return res.status(404).json({ error: 'Despesa fixa não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ despesa: result.despesa });
  } catch (err) { next(err); }
});

router.patch('/:id/ativar', async (req, res, next) => {
  try {
    const result = await despesasFixas.definirAtivo(req.params.id, true);
    if (result.notFound) return res.status(404).json({ error: 'Despesa fixa não encontrada.' });
    res.json({ despesa: result.despesa });
  } catch (err) { next(err); }
});

router.patch('/:id/desativar', async (req, res, next) => {
  try {
    const result = await despesasFixas.definirAtivo(req.params.id, false);
    if (result.notFound) return res.status(404).json({ error: 'Despesa fixa não encontrada.' });
    res.json({ despesa: result.despesa });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await despesasFixas.excluirDespesaFixa(req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Despesa fixa não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/despesas-fixas/gerar — força um ciclo de geração imediato
// (além do automático em background, ver lib/despesasFixasScheduler.js),
// pra quem acabou de cadastrar uma despesa fixa não precisar esperar o
// próximo ciclo pra ver a conta a pagar aparecer.
router.post('/gerar', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    const resultado = await despesasFixas.gerarContasPagarAutomaticas({ empresaId: empresaId || undefined });
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
