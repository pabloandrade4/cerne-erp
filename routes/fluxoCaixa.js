// Fluxo de Caixa — ativado em 25/08/2026 (ver docs/04-alteracoes.md).
// Router fino: toda a regra de negócio mora em lib/fluxoCaixa.js.
const express = require('express');
const fluxoCaixa = require('../lib/fluxoCaixa');

const router = express.Router();

// GET /api/fluxo-caixa?empresaId=ID&periodo=7d|15d|30d|mes|proximoMes|personalizado&desde=&ate=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, desde, ate } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const resultado = await fluxoCaixa.gerarFluxoDeCaixa({ empresaId, periodoChave: periodo, desde, ate });
    res.json(resultado);
  } catch (err) { next(err); }
});

// POST /api/fluxo-caixa/saldo-inicial { empresaId, valor, dataReferencia, observacao }
// Saldo SEMPRE informado pelo usuário — o ERP não lê nenhum banco de
// verdade (ver comentário em lib/fluxoCaixa.js).
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

module.exports = router;
