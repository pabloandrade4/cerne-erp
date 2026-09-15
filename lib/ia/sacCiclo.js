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
  // CORREÇÃO (15/09/2026 — usuário reportou "tem 2 pos vendas no Mercado
  // Livre mas no sistema não consta nada"): antes só voltava um número —
  // agora `detalhesPorFonte` mostra o que aconteceu em CADA fonte
  // (perguntas/mensagens/reclamações) — quantas foram verificadas e
  // qualquer erro que a API tenha devolvido — pra nunca mais um "0"
  // silencioso esconder uma falha real (ver routes/sac.js e a tela).
  const detalhesPorFonte = { perguntas: null, mensagens: null, reclamacoes: null };
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
      ['perguntas', 'mensagens', 'reclamacoes'].forEach((fonte) => { detalhesPorFonte[fonte] = resultado[fonte]; });
    } catch (err) {
      console.error(`[SAC Mercado Livre][ciclo] conta ${conta.id}: ${err.message}`);
      erros.push({ contaId: conta.id, erro: err.message });
    }
  }
  return { empresaId, marketplace: 'mercado_livre', contasProcessadas: contas.length, atendimentosNovos, sugestoesGeradas, erros, detalhesPorFonte };
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
  const detalhesPorFonte = { conversas: null, devolucoes: null };
  for (const conta of contas) {
    try {
      const resultado = await sincronizarContaShopee(conta.id);
      const idsNovos = [
        ...(resultado.conversas.idsNovos || []),
        ...(resultado.devolucoes.idsNovos || []),
      ];
      atendimentosNovos += idsNovos.length;
      sugestoesGeradas += await gerarSugestoesParaIds(empresaId, idsNovos);
      ['conversas', 'devolucoes'].forEach((fonte) => { detalhesPorFonte[fonte] = resultado[fonte]; });
    } catch (err) {
      console.error(`[SAC Shopee][ciclo] conta ${conta.id}: ${err.message}`);
      erros.push({ contaId: conta.id, erro: err.message });
    }
  }
  return { empresaId, marketplace: 'shopee', contasProcessadas: contas.length, atendimentosNovos, sugestoesGeradas, erros, detalhesPorFonte };
}

// Versões "todas as empresas ativas" — 15/09/2026, pedido explícito do
// usuário ("nao quero ter que ficar sincronizando nada quero tudo
// automatico"): usadas pelo lib/ia/sacScheduler.js pra rodar o ciclo de
// cada agente sozinho, em background, sem depender de ninguém clicar em
// "Gerar agora". Mesmo padrão de lib/ia/adsDecisoesCiclo.js#executarCicloDecisoesAds()
// — Promise.allSettled pra uma empresa com erro nunca travar as outras.
async function executarCicloSacMercadoLivre() {
  const { rows: empresas } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  const resultados = await Promise.allSettled(empresas.map((e) => executarCicloSacMercadoLivreEmpresa(e.id)));
  const comErro = [];
  let atendimentosNovos = 0;
  let sugestoesGeradas = 0;
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      const erro = String((r.reason && r.reason.message) || r.reason);
      comErro.push({ empresaId: empresas[i].id, erro });
      console.error(`[SAC Mercado Livre][scheduler] empresa ${empresas[i].id} falhou: ${erro}`);
    } else {
      atendimentosNovos += r.value.atendimentosNovos || 0;
      sugestoesGeradas += r.value.sugestoesGeradas || 0;
    }
  });
  return { empresasProcessadas: empresas.length, atendimentosNovos, sugestoesGeradas, comErro };
}

async function executarCicloSacShopee() {
  const { rows: empresas } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  const resultados = await Promise.allSettled(empresas.map((e) => executarCicloSacShopeeEmpresa(e.id)));
  const comErro = [];
  let atendimentosNovos = 0;
  let sugestoesGeradas = 0;
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      const erro = String((r.reason && r.reason.message) || r.reason);
      comErro.push({ empresaId: empresas[i].id, erro });
      console.error(`[SAC Shopee][scheduler] empresa ${empresas[i].id} falhou: ${erro}`);
    } else {
      atendimentosNovos += r.value.atendimentosNovos || 0;
      sugestoesGeradas += r.value.sugestoesGeradas || 0;
    }
  });
  return { empresasProcessadas: empresas.length, atendimentosNovos, sugestoesGeradas, comErro };
}

module.exports = {
  executarCicloSacMercadoLivreEmpresa,
  executarCicloSacShopeeEmpresa,
  executarCicloSacMercadoLivre,
  executarCicloSacShopee,
};
