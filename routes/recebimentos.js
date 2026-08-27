// Recebimentos (repasses de marketplace) — ativado em 24/08/2026, reescrito
// no Passo 1 da tarefa "Recebimentos + Fluxo de Caixa + IA Gestora"
// (27/08/2026, ver docs/04-alteracoes.md). A lista (GET /) continua
// somente leitura; as 3 ações manuais abaixo (marcar disponível/recebido,
// definir previsão de liberação) são as ÚNICAS formas de mudar o status de
// um recebimento por aqui — a IA Gestora nunca chama essas rotas (Passo 3
// é somente leitura) e a conciliação automática do extrato (Passo 2) usa
// lib/recebimentosMl.js#marcarComoRecebidoPorConciliacao internamente, com
// sua própria confirmação explícita do usuário.
const express = require('express');
const { calcularPeriodo } = require('../lib/periodo');
const recebimentosMl = require('../lib/recebimentosMl');

const router = express.Router();

// GET /api/recebimentos?empresaId=ID&periodo=30d
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const recebimentos = await recebimentosMl.listarRecebimentosMl({ empresaId, desde: periodoCalc.desde, ate: periodoCalc.ate });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      recebimentos,
    });
  } catch (err) { next(err); }
});

// GET /api/recebimentos/resumo?empresaId=ID — SEMPRE atual, independe do
// período do header (recebido hoje/mês, a receber total/7/15/30 dias, por
// marketplace/loja). Ver lib/recebimentosMl.js#resumoRecebimentosMarketplace.
router.get('/resumo', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resumo = await recebimentosMl.resumoRecebimentosMarketplace(empresaId);
    res.json({ resumo });
  } catch (err) { next(err); }
});

router.patch('/:id/disponivel', async (req, res, next) => {
  try {
    const result = await recebimentosMl.marcarComoDisponivel(req.params.id, req.body || {});
    if (result.notFound) return res.status(404).json({ error: 'Recebimento não encontrado.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ recebimento: result.recebimento });
  } catch (err) { next(err); }
});

router.patch('/:id/recebido', async (req, res, next) => {
  try {
    const result = await recebimentosMl.marcarComoRecebido(req.params.id, req.body || {});
    if (result.notFound) return res.status(404).json({ error: 'Recebimento não encontrado.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ recebimento: result.recebimento });
  } catch (err) { next(err); }
});

router.patch('/:id/previsao-liberacao', async (req, res, next) => {
  try {
    const result = await recebimentosMl.definirPrevisaoLiberacao(req.params.id, req.body && req.body.dataPrevistaLiberacao);
    if (result.notFound) return res.status(404).json({ error: 'Recebimento não encontrado.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ recebimento: result.recebimento });
  } catch (err) { next(err); }
});

module.exports = router;
