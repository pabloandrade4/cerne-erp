// Registro dos "Agentes de IA" — Fase 1 (14/09/2026), pedido explícito do
// usuário: uma aba dedicada, com cada agente separado, preparada para o
// usuário no futuro conseguir "conversar com cada um separado" (nenhuma
// conversa é implementada agora — só a identidade que uma conversa futura
// vai usar, ver tabela ia_agentes em db/schema.sql).
const express = require('express');
const pool = require('../db/pool');

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

module.exports = router;
