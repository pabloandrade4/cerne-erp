// Visão Geral — bloco inferior ativado em 26/08/2026 (pedido do usuário,
// em 3 passos: Evolução diária + Por marketplace, Fluxo de Caixa +
// Conexões & Empresas, Alertas & IA — ver docs/02-decisoes.md e
// docs/04-alteracoes.md). "Evolução diária" já vem de
// GET /api/relatorios/resumo-vendas (campo serieDiaria, existente desde
// antes) — este router cobre só o resto. Router fino, mesmo padrão do
// resto do projeto: toda a regra de negócio mora em
// lib/visaoGeralPainel.js.
const express = require('express');
const { painelVisaoGeral } = require('../lib/visaoGeralPainel');

const router = express.Router();

// GET /api/visao-geral/painel?empresaId=ID&periodo=30d
router.get('/painel', async (req, res, next) => {
  try {
    const { empresaId, periodo } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resultado = await painelVisaoGeral({ empresaId, periodoChave: periodo });
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
