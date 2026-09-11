// Central de Alertas — ativada em 01/09/2026 (Etapa 7 pedida pelo usuário,
// ver docs/04-alteracoes.md). Router fino: toda a regra de negócio mora em
// lib/ia/radar.js (mesmo padrão de routes/ads.js/routes/dre.js) — esta tela
// NUNCA dispara um ciclo de análise novo (isso é sempre o job periódico em
// segundo plano, lib/ia/radarScheduler.js), só lê/atualiza o que já foi
// persistido em radar_alertas.
const express = require('express');
const {
  listarAlertasCentral,
  marcarAlertaVisualizado,
  marcarAlertaIgnorado,
  marcarAlertaResolvidoManual,
  reabrirAlertaManual,
} = require('../lib/ia/radar');

const router = express.Router();

// GET /api/alertas?empresaId=ID&prioridade=critico|alto|medio|baixo&status=novo|visualizado|resolvido|ignorado&categoria=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, prioridade, status, categoria } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resultado = await listarAlertasCentral(Number(empresaId), { prioridade, status, categoria });
    res.json(resultado);
  } catch (err) { next(err); }
});

// Toda ação abaixo exige empresaId no corpo — nunca só o id do alerta —
// pra nunca deixar uma empresa alterar/marcar como visualizado um alerta
// de outra (mesma regra de isolamento por empresa/conta do resto do ERP;
// lib/ia/radar.js já filtra por WHERE empresa_id = $2 nas 4 funções).
router.patch('/:id/visualizar', async (req, res, next) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const ok = await marcarAlertaVisualizado(Number(req.params.id), Number(empresaId));
    if (!ok) return res.status(404).json({ error: 'Alerta não encontrado para esta empresa.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.patch('/:id/ignorar', async (req, res, next) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const ok = await marcarAlertaIgnorado(Number(req.params.id), Number(empresaId));
    if (!ok) return res.status(404).json({ error: 'Alerta não encontrado para esta empresa (ou já está resolvido).' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.patch('/:id/resolver', async (req, res, next) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const ok = await marcarAlertaResolvidoManual(Number(req.params.id), Number(empresaId));
    if (!ok) return res.status(404).json({ error: 'Alerta não encontrado para esta empresa.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.patch('/:id/reabrir', async (req, res, next) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const ok = await reabrirAlertaManual(Number(req.params.id), Number(empresaId));
    if (!ok) return res.status(404).json({ error: 'Alerta não encontrado para esta empresa.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
