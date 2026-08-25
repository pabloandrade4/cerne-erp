// IA Gestora — ativada em 2026, 3 passos pedidos pelo usuário (ver
// docs/02-decisoes.md e docs/04-alteracoes.md). Router fino: toda a lógica
// mora em lib/ia/orchestrator.js e lib/ia/ferramentas.js. A chave do
// provedor de IA (IA_API_KEY) nunca passa por aqui em texto —
// lib/ia/providers/index.js lê direto da variável de ambiente.
const express = require('express');
const { responderPergunta } = require('../lib/ia/orchestrator');

const router = express.Router();

// POST /api/ia-gestora/perguntar
// Body: { empresaId, periodo, pergunta, historico? }
// `empresaId` e `periodo` são sempre os do cabeçalho (window.CerneFiltro no
// front-end) — nunca uma escolha do modelo de IA (ver comentário em
// lib/ia/ferramentas.js sobre por que isso é estrutural, não uma
// convenção).
router.post('/perguntar', async (req, res, next) => {
  try {
    const { empresaId, periodo, pergunta, historico } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (!pergunta || !String(pergunta).trim()) return res.status(400).json({ error: 'Informe a pergunta.' });

    const resultado = await responderPergunta({ empresaId, periodoChave: periodo, pergunta, historico });
    res.json(resultado);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
