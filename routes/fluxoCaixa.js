// Fluxo de Caixa — ativado em 25/08/2026, reescrito na ETAPA 3 em
// 27/08/2026 (ver docs/04-alteracoes.md). Router fino: toda a regra de
// negócio mora em lib/fluxoCaixa.js.
const express = require('express');
const fluxoCaixa = require('../lib/fluxoCaixa');

const router = express.Router();

// GET /api/fluxo-caixa?empresaId=ID&periodo=7d|15d|30d|mes|proximoMes|personalizado&desde=&ate=&contaBancariaId=ID(opcional)
// Sem contaBancariaId: fluxo CONSOLIDADO da empresa (todas as contas
// ativas). Com contaBancariaId: escopado a uma conta (ver limitação
// documentada em lib/fluxoCaixa.js#gerarFluxoDeCaixa — o previsto continua
// sempre em nível de empresa).
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, desde, ate, contaBancariaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const resultado = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId, periodoChave: periodo, desde, ate, contaBancariaId: contaBancariaId || null });
    res.json(resultado);
  } catch (err) { next(err); }
});

// ---- Saldo inicial LEGADO (só por empresa — ETAPA 3 preserva, nunca mais usado pela fórmula nova) ----

// POST /api/fluxo-caixa/saldo-inicial { empresaId, valor, dataReferencia, observacao }
router.post('/saldo-inicial', async (req, res, next) => {
  try {
    const result = await fluxoCaixa.definirSaldoInicial(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ saldoInicial: result.saldoInicial });
  } catch (err) { next(err); }
});

router.get('/saldo-inicial', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const saldoInicial = await fluxoCaixa.buscarSaldoInicial(empresaId);
    res.json({ saldoInicial });
  } catch (err) { next(err); }
});

// ---- Saldo inicial POR CONTA BANCÁRIA (ETAPA 3 — fonte real a partir de agora) ----

// POST /api/fluxo-caixa/saldo-inicial-conta { empresaId, contaBancariaId, valor, dataReferencia, observacao }
router.post('/saldo-inicial-conta', async (req, res, next) => {
  try {
    const result = await fluxoCaixa.definirSaldoInicialConta(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ saldoInicial: result.saldoInicial });
  } catch (err) { next(err); }
});

// GET /api/fluxo-caixa/saldo-inicial-conta?contaBancariaId=ID
router.get('/saldo-inicial-conta', async (req, res, next) => {
  try {
    const { contaBancariaId } = req.query;
    if (!contaBancariaId) return res.status(400).json({ error: 'Informe contaBancariaId.' });
    const saldoInicial = await fluxoCaixa.buscarSaldoInicialConta(contaBancariaId);
    res.json({ saldoInicial });
  } catch (err) { next(err); }
});

// POST /api/fluxo-caixa/transferencia-interna { empresaId, movimentoOrigemId, movimentoDestinoId }
// Classifica manualmente um par de movimentos como transferência interna —
// sempre uma ação explícita (nunca automática, ver lib/fluxoCaixa.js).
router.post('/transferencia-interna', async (req, res, next) => {
  try {
    const { empresaId, movimentoOrigemId, movimentoDestinoId } = req.body || {};
    if (!empresaId || !movimentoOrigemId || !movimentoDestinoId) {
      return res.status(400).json({ error: 'Informe empresaId, movimentoOrigemId e movimentoDestinoId.' });
    }
    const result = await fluxoCaixa.classificarComoTransferenciaInterna({ empresaId, movimentoOrigemId, movimentoDestinoId });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
