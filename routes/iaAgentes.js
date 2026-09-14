// Registro dos "Agentes de IA" — Fase 1 (14/09/2026), pedido explícito do
// usuário: uma aba dedicada, com cada agente separado, preparada para o
// usuário no futuro conseguir "conversar com cada um separado" (nenhuma
// conversa é implementada agora — só a identidade que uma conversa futura
// vai usar, ver tabela ia_agentes em db/schema.sql).
const express = require('express');
const pool = require('../db/pool');
const { obterResumoHub, listarHistorico } = require('../lib/ia/agentesResumo');

const router = express.Router();

// GET /api/ia-agentes — lista os agentes ativos, na ordem cadastrada.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT codigo, nome, descricao, icone FROM ia_agentes WHERE ativo = true ORDER BY ordem, id'
    );
    res.json({ agentes: rows.map((r) => ({ codigo: r.codigo, nome: r.nome, descricao: r.descricao, icone: r.icone })) });
  } catch (err) { next(err); }
});

// GET /api/ia-agentes/stats?empresaId=ID — KPIs e stats por agente da tela
// "Agentes de IA" (hub), 14/09/2026. Ver lib/ia/agentesResumo.js: nenhum
// número aqui é inventado, tudo vem de tabelas já preenchidas pelos ciclos
// automáticos reais.
router.get('/stats', async (req, res, next) => {
  try {
    const empresaId = Number(req.query.empresaId);
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resumo = await obterResumoHub(empresaId);
    res.json(resumo);
  } catch (err) { next(err); }
});

// GET /api/ia-agentes/historico?empresaId=ID&limit=N — eventos reais
// (sugestão gerada, decisão do usuário, alerta do Radar), mais recente
// primeiro. Ver lib/ia/agentesResumo.js#listarHistorico.
router.get('/historico', async (req, res, next) => {
  try {
    const empresaId = Number(req.query.empresaId);
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const eventos = await listarHistorico(empresaId, req.query.limit);
    res.json({ eventos });
  } catch (err) { next(err); }
});

module.exports = router;
