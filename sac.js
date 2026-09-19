// Rotas HTTP dos agentes de SAC (Mercado Livre e Shopee) — 14/09/2026,
// pedido explícito do usuário. Router fino: toda a lógica de banco fica em
// lib/ia/sacStore.js, a sincronização em lib/ia/sacMercadoLivre.js /
// lib/ia/sacShopee.js, e o ciclo completo (sincronizar + gerar sugestão)
// em lib/ia/sacCiclo.js — mesmo padrão de routes/ads.js/routes/promocoes.js.
//
// MODO SUPERVISIONADO — FASE 1: nenhuma rota aqui envia nada ao Mercado
// Livre/Shopee. PUT /atendimentos/:id/decisao só REGISTRA a decisão do
// usuário (aprovar/editar/recusar) — ver lib/ia/sacStore.js#registrarDecisao.
const express = require('express');
const router = express.Router();
const sacStore = require('./../lib/ia/sacStore');
const { executarCicloSacMercadoLivreEmpresa, executarCicloSacShopeeEmpresa } = require('../lib/ia/sacCiclo');
const { obterStatusScheduler } = require('../lib/ia/sacScheduler');

function marketplaceValido(m) {
  return sacStore.MARKETPLACES.includes(m);
}

// GET /api/sac/atendimentos?empresaId=&marketplace=&tipoOrigem=&status=&urgente=&busca=
router.get('/atendimentos', async (req, res, next) => {
  try {
    const { empresaId, marketplace, tipoOrigem, status, urgente, busca, limit } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (marketplace && !marketplaceValido(marketplace)) {
      return res.status(400).json({ error: 'marketplace inválido — use mercado_livre ou shopee.' });
    }
    const atendimentos = await sacStore.listarAtendimentos(Number(empresaId), {
      marketplace: marketplace || null,
      tipoOrigem: tipoOrigem || null,
      status: status || null,
      urgente: urgente === 'true' ? true : null,
      busca: busca || null,
      limit,
    });
    res.json({ atendimentos });
  } catch (err) { next(err); }
});

// GET /api/sac/atendimentos/:id?empresaId=
router.get('/atendimentos/:id', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const atendimento = await sacStore.buscarAtendimento(Number(req.params.id), Number(empresaId));
    if (!atendimento) return res.status(404).json({ error: 'Atendimento não encontrado.' });
    res.json(atendimento);
  } catch (err) { next(err); }
});

// PUT /api/sac/atendimentos/:id/resolver { empresaId } — marca resolvido
// manualmente (ex.: o usuário já resolveu por fora do Cerne).
router.put('/atendimentos/:id/resolver', async (req, res, next) => {
  try {
    const { empresaId } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const ok = await sacStore.marcarResolvido(Number(req.params.id), Number(empresaId));
    if (!ok) return res.status(404).json({ error: 'Atendimento não encontrado.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/sac/respostas/:id/decisao { empresaId, statusDecisao: 'aprovada'|'editada'|'recusada', respostaFinal?, decididoPor? }
// Só registra a decisão — NUNCA chama a API do Mercado Livre/Shopee (ver
// cabeçalho do arquivo). 'aprovada' e 'editada' exigem respostaFinal (o
// texto que o usuário decidiu enviar, mesmo que nunca seja enviado de
// verdade nesta fase — é isso que vira aprendizado, ver db/schema.sql).
router.put('/respostas/:id/decisao', async (req, res, next) => {
  try {
    const { empresaId, statusDecisao, respostaFinal, decididoPor } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (!['aprovada', 'editada', 'recusada'].includes(statusDecisao)) {
      return res.status(400).json({ error: 'statusDecisao inválido — use aprovada, editada ou recusada.' });
    }
    if (statusDecisao !== 'recusada' && !respostaFinal) {
      return res.status(400).json({ error: 'Informe respostaFinal para aprovar ou editar.' });
    }

    const pendente = await sacStore.buscarRespostaPendenteDaEmpresa(Number(req.params.id), Number(empresaId));
    if (!pendente) return res.status(404).json({ error: 'Sugestão não encontrada, ou já foi decidida antes.' });

    const decisao = await sacStore.registrarDecisao(Number(req.params.id), { statusDecisao, respostaFinal, decididoPor });
    res.json(decisao);
  } catch (err) { next(err); }
});

// GET /api/sac/stats?empresaId=&marketplace=
router.get('/stats', async (req, res, next) => {
  try {
    const { empresaId, marketplace } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (!marketplaceValido(marketplace)) {
      return res.status(400).json({ error: 'Informe marketplace (mercado_livre ou shopee).' });
    }
    const stats = await sacStore.estatisticasAgente(Number(empresaId), marketplace);
    res.json(stats);
  } catch (err) { next(err); }
});

// POST /api/sac/gerar-agora { empresaId, marketplace } — roda o ciclo
// completo (sincronizar + gerar sugestões) na hora, pra não precisar
// esperar um ciclo automático. Só leitura/análise (ver cabeçalho do
// arquivo) — nenhuma resposta é enviada a lugar nenhum.
router.post('/gerar-agora', async (req, res, next) => {
  try {
    const { empresaId, marketplace } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (!marketplaceValido(marketplace)) {
      return res.status(400).json({ error: 'Informe marketplace (mercado_livre ou shopee).' });
    }
    const resultado = marketplace === 'shopee'
      ? await executarCicloSacShopeeEmpresa(Number(empresaId))
      : await executarCicloSacMercadoLivreEmpresa(Number(empresaId));
    res.json(resultado);
  } catch (err) { next(err); }
});

// GET /api/sac/status-automatico — estado (em memória do servidor) da
// verificação automática em background (15/09/2026, pedido explícito do
// usuário "nao quero ter que ficar sincronizando nada quero tudo
// automatico" — ver lib/ia/sacScheduler.js). Mesmo padrão de
// GET /api/integracoes/mercadolivre/status-automatico — usado pra mostrar
// na tela "verificado automaticamente há Xs", com "Sincronizar agora"
// como atalho manual (não a única forma de atualizar).
router.get('/status-automatico', (req, res) => {
  const s = obterStatusScheduler();
  res.json({
    ativo: s.ativo,
    intervaloSegundos: Math.round(s.intervaloMs / 1000),
    emExecucao: s.emExecucao,
    ultimaExecucaoEm: s.ultimaExecucaoEm,
    ultimoCicloOk: s.ultimoCicloOk,
    mercadoLivre: s.mercadoLivre,
    shopee: s.shopee,
  });
});

module.exports = router;
