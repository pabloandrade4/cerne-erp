// Orquestrador dos agentes de SAC — 14/09/2026, pedido explícito do
// usuário ("por enquanto vai ser apenas leitura e analise... deve ter um
// agente para shopee e outro para o mercado livre"). Junta sincronização
// (lib/ia/sacMercadoLivre.js / lib/ia/sacShopee.js) + geração de sugestão
// de resposta (lib/ia/sacRespostaIa.js) num só ciclo por empresa, exposto
// via "Gerar agora" (ver routes/sac.js) — mesmo padrão de
// POST /api/ads/decisoes/gerar-agora e POST /api/promocoes/analisar.
//
// Só gera sugestão de resposta pra atendimentos NOVOS ou REABERTOS neste
// ciclo (ehSituacaoNova) — um atendimento que já tem uma sugestão pendente
// sem novidade nenhuma não gasta uma chamada de IA de novo à toa.
const pool = require('../../db/pool');
const { sincronizarContaMercadoLivre } = require('./sacMercadoLivre');
const { sincronizarContaShopee } = require('./sacShopee');
const { gerarSugestaoAtendimento } = require('./sacRespostaIa');
const sacStore = require('./sacStore');

async function gerarSugestoesParaIds(empresaId, ids) {
  let geradas = 0;
  for (const id of ids) {
    try {
      const atendimento = await sacStore.buscarAtendimento(id, empresaId);
      if (!atendimento) continue;
      const sugestao = await gerarSugestaoAtendimento(atendimento);
      await sacStore.upsertSugestaoPendente(id, sugestao);
      geradas++;
    } catch (err) {
      console.error(`[SAC][ciclo] falha ao gerar sugestão pro atendimento ${id}: ${err.message}`);
    }
  }
  return geradas;
}

async function executarCicloSacMercadoLivreEmpresa(empresaId) {
  const { rows: contas } = await pool.query(
    "SELECT id FROM ml_contas WHERE empresa_id = $1 AND status = 'ativa' ORDER BY id",
    [empresaId]
  );
  if (!contas.length) return { empresaId, marketplace: 'mercado_livre', contasProcessadas: 0, atendimentosNovos: 0, sugestoesGeradas: 0 };

  let atendimentosNovos = 0;
  let sugestoesGeradas = 0;
  const erros = [];
  for (const conta of contas) {
    try {
      const resultado = await sincronizarContaMercadoLivre(conta.id);
      const idsNovos = [
        ...(resultado.perguntas.idsNovos || []),
        ...(resultado.mensagens.idsNovos || []),
        ...(resultado.reclamacoes.idsNovos || []),
      ];
      atendimentosNovos += idsNovos.length;
      sugestoesGeradas += await gerarSugestoesParaIds(empresaId, idsNovos);
    } catch (err) {
      console.error(`[SAC Mercado Livre][ciclo] conta ${conta.id}: ${err.message}`);
      erros.push({ contaId: conta.id, erro: err.message });
    }
  }
  return { empresaId, marketplace: 'mercado_livre', contasProcessadas: contas.length, atendimentosNovos, sugestoesGeradas, erros };
}

async function executarCicloSacShopeeEmpresa(empresaId) {
  const { rows: contas } = await pool.query(
    "SELECT id FROM shopee_contas WHERE empresa_id = $1 AND status = 'ativa' ORDER BY id",
    [empresaId]
  );
  if (!contas.length) return { empresaId, marketplace: 'shopee', contasProcessadas: 0, atendimentosNovos: 0, sugestoesGeradas: 0 };

  let atendimentosNovos = 0;
  let sugestoesGeradas = 0;
  const erros = [];
  for (const conta of contas) {
    try {
      const resultado = await sincronizarContaShopee(conta.id);
      const idsNovos = [
        ...(resultado.conversas.idsNovos || []),
        ...(resultado.devolucoes.idsNovos || []),
      ];
      atendimentosNovos += idsNovos.length;
      sugestoesGeradas += await gerarSugestoesParaIds(empresaId, idsNovos);
    } catch (err) {
      console.error(`[SAC Shopee][ciclo] conta ${conta.id}: ${err.message}`);
      erros.push({ contaId: conta.id, erro: err.message });
    }
  }
  return { empresaId, marketplace: 'shopee', contasProcessadas: contas.length, atendimentosNovos, sugestoesGeradas, erros };
}

module.exports = { executarCicloSacMercadoLivreEmpresa, executarCicloSacShopeeEmpresa };
