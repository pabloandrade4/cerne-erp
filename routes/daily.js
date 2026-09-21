// "Daily dos Agentes" — Etapa 2 (14/09/2026, pedido explícito do usuário),
// com o disparo manual daqui (mesmo padrão de
// POST /api/ads/decisoes/gerar-agora) — o agendamento automático das 09:00
// é a Etapa 4 (lib/ia/dailyScheduler.js, já implementada). Desde 20/09/2026
// (Etapa 3 — Agente Coordenador), GET /ultima também devolve `correlacoes`
// — o cruzamento entre achados de agentes diferentes pro mesmo SKU (ver
// lib/ia/coordenadorDiario.js) — junto com `achadosPorAgente`, sem nenhuma
// mudança de rota: dailyCiclo.js#buscarUltimaReuniao já devolve tudo no
// mesmo objeto.
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
