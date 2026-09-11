// Conciliação bancária (Passo 2, 27/08/2026, ver docs/04-alteracoes.md).
// Sempre: sugestão (GET /sugestoes) -> confirmação EXPLÍCITA do usuário
// (POST /confirmar) — nunca automática. Ver lib/conciliacaoBancaria.js.
const express = require('express');
const conciliacaoBancaria = require('../lib/conciliacaoBancaria');

const router = express.Router();

// GET /api/conciliacao/sugestoes?empresaId=ID&contaBancariaId=ID
router.get('/sugestoes', async (req, res, next) => {
  try {
    const { empresaId, contaBancariaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (!contaBancariaId) return res.status(400).json({ error: 'Informe contaBancariaId.' });
    const sugestoes = await conciliacaoBancaria.sugerirConciliacoes({ empresaId, contaBancariaId });
    res.json({ sugestoes });
  } catch (err) { next(err); }
});

// POST /api/conciliacao/confirmar
// body: { movimentoId, tipo: 'recebimento_marketplace'|'conta_receber'|'conta_pagar', alvoId }
router.post('/confirmar', async (req, res, next) => {
  try {
    const { movimentoId, tipo, alvoId } = req.body || {};
    if (!movimentoId || !tipo || !alvoId) return res.status(400).json({ error: 'Informe movimentoId, tipo e alvoId.' });
    const result = await conciliacaoBancaria.confirmarConciliacao({ movimentoId, tipo, alvoId });
    if (result.notFound) return res.status(404).json({ error: 'Movimento do extrato não encontrado.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ movimento: result.movimento, alvo: result.alvo });
  } catch (err) { next(err); }
});

// PATCH /api/conciliacao/:movimentoId/ignorar
router.patch('/:movimentoId/ignorar', async (req, res, next) => {
  try {
    const result = await conciliacaoBancaria.ignorarMovimento(req.params.movimentoId);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ movimento: result.movimento });
  } catch (err) { next(err); }
});

module.exports = router;
