// "Daily dos Agentes" — Etapa 2 (14/09/2026, pedido explícito do usuário).
// Nesta etapa só existe disparo MANUAL (mesmo padrão de
// POST /api/ads/decisoes/gerar-agora) — o agendamento automático das 09:00
// é a Etapa 4, ainda não implementada. Sem Agente Coordenador ainda
// (Etapa 3): estas rotas só expõem os achados que cada especialista gerou,
// sem nenhum cruzamento entre eles.
const express = require('express');
const { executarDailyEmpresa, buscarUltimaReuniao } = require('../lib/ia/dailyCiclo');

const router = express.Router();

// POST /api/ia/daily/gerar-agora { empresaId } — roda a coleta de achados
// de todos os especialistas cadastrados (lib/ia/especialistas.js) na hora.
router.post('/gerar-agora', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resultado = await executarDailyEmpresa(Number(empresaId));
    res.json(resultado);
  } catch (err) { next(err); }
});

// GET /api/ia/daily/ultima?empresaId= — última reunião da empresa (qualquer
// status) com os achados agrupados por agente, para conferência.
router.get('/ultima', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const resultado = await buscarUltimaReuniao(Number(empresaId));
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
