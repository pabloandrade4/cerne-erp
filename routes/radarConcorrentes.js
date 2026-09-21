// Radar de Concorrentes (21/09/2026) — ver comentário grande em
// lib/radarConcorrentes.js e db/schema.sql (tabela radar_concorrentes).
const express = require('express');
const {
  cadastrarConcorrente, desativarConcorrente, listarConcorrentesComUltimaLeitura,
  historicoPrecos, listarAlertas, obterResumo, executarLeituraDeUmConcorrente,
} = require('../lib/radarConcorrentes');
const pool = require('../db/pool');

const router = express.Router();

// GET /api/radar-concorrentes?empresaId=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const concorrentes = await listarConcorrentesComUltimaLeitura({ empresaId: Number(empresaId) });
    res.json({ concorrentes });
  } catch (err) { next(err); }
});

// GET /api/radar-concorrentes/resumo?empresaId=
router.get('/resumo', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resumo = await obterResumo({ empresaId: Number(empresaId) });
    res.json(resumo);
  } catch (err) { next(err); }
});

// GET /api/radar-concorrentes/alertas?empresaId=&limite=
router.get('/alertas', async (req, res, next) => {
  try {
    const { empresaId, limite } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const alertas = await listarAlertas({ empresaId: Number(empresaId), limite: limite ? Number(limite) : undefined });
    res.json({ alertas });
  } catch (err) { next(err); }
});

// GET /api/radar-concorrentes/:id/historico?empresaId=
router.get('/:id/historico', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const historico = await historicoPrecos({ empresaId: Number(empresaId), id: Number(req.params.id) });
    res.json({ historico });
  } catch (err) { next(err); }
});

// POST /api/radar-concorrentes  { empresaId, nomeConcorrente, linkAnuncio, sku, marketplace }
router.post('/', async (req, res, next) => {
  try {
    const { empresaId, nomeConcorrente, linkAnuncio, sku, marketplace } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const registro = await cadastrarConcorrente({ empresaId: Number(empresaId), nomeConcorrente, linkAnuncio, sku, marketplace });
    res.status(201).json(registro);
  } catch (err) { next(err); }
});

// POST /api/radar-concorrentes/:id/reler?empresaId= — força uma nova leitura
// agora (botão "Atualizar" na tela), sem esperar o próximo ciclo automático.
router.post('/:id/reler', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const { rows } = await pool.query(
      'SELECT * FROM radar_concorrentes WHERE id = $1 AND empresa_id = $2',
      [Number(req.params.id), Number(empresaId)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Concorrente monitorado não encontrado.' });
    if (!rows[0].monitoramento_automatico) {
      return res.status(400).json({ error: 'Este concorrente não tem monitoramento automático disponível (marketplace sem leitura pública neste sistema) — atualize o link/anúncio manualmente.' });
    }
    const resultado = await executarLeituraDeUmConcorrente(rows[0]);
    res.json(resultado);
  } catch (err) { next(err); }
});

// DELETE /api/radar-concorrentes/:id?empresaId= — arquiva (nunca apaga o histórico).
router.delete('/:id', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    await desativarConcorrente({ empresaId: Number(empresaId), id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
