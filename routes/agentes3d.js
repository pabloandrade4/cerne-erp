// Sala dos Agentes — visualização 3D dos processos automáticos do servidor
// (pedido explícito do usuário: "tem como fazer agentes de IA pra rodar
// 24h por dia e fazer uma sala 3D onde vai mostrar todos agentes
// trabalhando?"). Router bem fino, propositalmente: NENHUM cálculo/estado
// novo é criado aqui — cada "agente" já roda 24h por dia sozinho no
// servidor desde antes (ver server.js#start, cada um com seu próprio
// scheduler em lib/*Scheduler.js), e cada scheduler já expõe seu status em
// memória através de uma função obterStatus*() própria (mesma que já
// alimenta o indicador "Sincronizado há Xs" do header e as telas de
// Marketplaces/Ads/Despesas Fixas). Esta rota só REÚNE esses status já
// existentes num único formato, pra Sala dos Agentes não precisar bater em
// vários endpoints diferentes — nunca inventa um agente ou um campo que os
// schedulers não tenham. Total real hoje: 9 agentes de sincronização/IA
// (lib/syncScheduler.js cobre 2: pedidos ML e estoque ML) + a Daily dos
// Agentes (lib/ia/dailyScheduler.js, 19/09/2026, Etapa 4 — resumo diário
// automático por WhatsApp) = 10.
const express = require('express');
const { obterStatusSincronizacao } = require('../lib/syncScheduler');
const { obterStatusSincronizacaoAutomatica: obterStatusSincronizacaoShopee } = require('../lib/shopeeSyncScheduler');
const { obterStatusRenovacao: obterStatusRenovacaoTokenShopee } = require('../lib/shopeeTokenScheduler');
const { obterStatusSincronizacaoAds } = require('../lib/adsScheduler');
const { obterStatusGeracaoDespesasFixas } = require('../lib/despesasFixasScheduler');
const { obterStatusScheduler: obterStatusRadar } = require('../lib/ia/radarScheduler');
const { obterStatusScheduler: obterStatusPromocoes } = require('../lib/ia/promocoesScheduler');
const { obterStatusScheduler: obterStatusSac } = require('../lib/ia/sacScheduler');
const { obterStatusDaily } = require('../lib/ia/dailyScheduler');

const router = express.Router();

// Um "resumo" curto e honesto por agente, montado só a partir dos campos
// que aquele scheduler específico já expõe (nunca um texto genérico
// fingindo saber algo que o estado não tem). null/undefined vira "—" no
// front-end, nunca um número chutado.
function resumoSincronizacao(s, unidade) {
  const partes = [];
  if (s.contasProcessadas !== undefined) partes.push(s.contasProcessadas + ' conta(s) processada(s)');
  if (s.contasComErro && s.contasComErro.length) partes.push(s.contasComErro.length + ' com erro');
  return partes.length ? partes.join(' · ') : ('Aguardando o 1º ciclo de ' + unidade + '.');
}

// Resumo honesto do agendador da Daily — nunca finge que já enviou algo
// antes do horário configurado, e distingue "ainda não chegou a hora" de
// "já rodou hoje" (ver lib/ia/dailyScheduler.js#estado).
function resumoDaily(s) {
  if (!s.ultimaExecucaoEm) return 'Aguardando a 1ª verificação.';
  if (!s.horaJaChegouHoje) return `Aguardando o horário configurado (${s.horaEnvio}h, Brasília).`;
  const partes = [s.empresasProcessadas + ' empresa(s) processada(s) hoje'];
  partes.push(s.empresasNotificadas + ' resumo(s) enviado(s) por WhatsApp');
  return partes.join(' · ');
}

router.get('/status', (req, res) => {
  const ml = obterStatusSincronizacao();
  const shopeeSync = obterStatusSincronizacaoShopee();
  const shopeeToken = obterStatusRenovacaoTokenShopee();
  const ads = obterStatusSincronizacaoAds();
  const despesas = obterStatusGeracaoDespesasFixas();
  const radar = obterStatusRadar();
  const promocoes = obterStatusPromocoes();
  const sac = obterStatusSac();
  const daily = obterStatusDaily();

  const agentes = [
    {
      id: 'ml-pedidos', nome: 'Sincronização de Pedidos — Mercado Livre', categoria: 'sincronizacao',
      ativo: ml.ativo, emExecucao: ml.emExecucao, intervaloMs: ml.intervaloMs,
      ultimaExecucaoEm: ml.ultimaExecucaoEm, ultimoCicloOk: ml.ultimoCicloOk,
      resumo: resumoSincronizacao(ml, 'sincronização'),
    },
    {
      id: 'ml-estoque', nome: 'Sincronização de Estoque — Mercado Livre', categoria: 'sincronizacao',
      ativo: ml.ativo, emExecucao: ml.emExecucao, intervaloMs: ml.intervaloMs,
      ultimaExecucaoEm: ml.estoqueUltimaExecucaoEm, ultimoCicloOk: ml.estoqueUltimoCicloOk,
      resumo: (ml.estoqueContasProcessadas !== undefined ? ml.estoqueContasProcessadas + ' conta(s) processada(s)' : 'Aguardando o 1º ciclo.')
        + (ml.estoqueComErro && ml.estoqueComErro.length ? ' · ' + ml.estoqueComErro.length + ' com erro' : ''),
    },
    {
      id: 'shopee-pedidos', nome: 'Sincronização de Pedidos — Shopee', categoria: 'sincronizacao',
      ativo: shopeeSync.ativo, emExecucao: shopeeSync.emExecucao, intervaloMs: shopeeSync.intervaloMs,
      ultimaExecucaoEm: shopeeSync.ultimaExecucaoEm, ultimoCicloOk: shopeeSync.ultimoCicloOk,
      resumo: resumoSincronizacao(shopeeSync, 'sincronização'),
    },
    {
      id: 'shopee-token', nome: 'Renovação de Token — Shopee', categoria: 'sincronizacao',
      ativo: shopeeToken.ativo, emExecucao: shopeeToken.emExecucao, intervaloMs: shopeeToken.intervaloMs,
      ultimaExecucaoEm: shopeeToken.ultimaExecucaoEm, ultimoCicloOk: shopeeToken.ultimoCicloOk,
      resumo: (shopeeToken.contasVerificadas !== undefined ? shopeeToken.contasVerificadas + ' conta(s) verificada(s), ' + (shopeeToken.contasRenovadas || 0) + ' renovada(s)' : 'Aguardando o 1º ciclo.'),
    },
    {
      id: 'ads', nome: 'Sincronização de Ads', categoria: 'sincronizacao',
      ativo: ads.ativo, emExecucao: ads.emExecucao, intervaloMs: ads.intervaloMs,
      ultimaExecucaoEm: ads.ultimaExecucaoEm, ultimoCicloOk: ads.ultimoCicloOk,
      resumo: resumoSincronizacao(ads, 'sincronização'),
    },
    {
      id: 'despesas-fixas', nome: 'Geração de Despesas Fixas', categoria: 'financeiro',
      ativo: despesas.ativo, emExecucao: despesas.emExecucao, intervaloMs: despesas.intervaloMs,
      ultimaExecucaoEm: despesas.ultimaExecucaoEm, ultimoCicloOk: despesas.ultimoCicloOk,
      resumo: despesas.ultimoTotalGeradas !== undefined ? despesas.ultimoTotalGeradas + ' conta(s) a pagar gerada(s) no último ciclo' : 'Aguardando o 1º ciclo.',
    },
    {
      id: 'radar-ia', nome: 'Radar da IA', categoria: 'ia',
      ativo: radar.ativo, emExecucao: radar.emExecucao, intervaloMs: radar.intervaloMs,
      ultimaExecucaoEm: radar.ultimaExecucaoEm, ultimoCicloOk: radar.ultimoCicloOk,
      resumo: radar.empresasProcessadas !== undefined ? radar.empresasProcessadas + ' empresa(s) analisada(s)' : 'Aguardando o 1º ciclo.',
    },
    {
      id: 'promocoes-ia', nome: 'IA de Promoções', categoria: 'ia',
      ativo: promocoes.ativo, emExecucao: promocoes.emExecucao, intervaloMs: promocoes.intervaloMs,
      ultimaExecucaoEm: promocoes.ultimaExecucaoEm, ultimoCicloOk: promocoes.ultimoCicloOk,
      resumo: promocoes.empresasProcessadas !== undefined ? promocoes.empresasProcessadas + ' empresa(s) analisada(s)' : 'Aguardando o 1º ciclo.',
    },
    {
      id: 'sac-ia', nome: 'SAC da IA (Mercado Livre + Shopee)', categoria: 'ia',
      ativo: sac.ativo, emExecucao: sac.emExecucao, intervaloMs: sac.intervaloMs,
      ultimaExecucaoEm: sac.ultimaExecucaoEm, ultimoCicloOk: sac.ultimoCicloOk,
      resumo: sac.mercadoLivre ? (((sac.mercadoLivre.sugestoesGeradas || 0) + (sac.shopee ? sac.shopee.sugestoesGeradas || 0 : 0)) + ' sugestão(ões) de resposta gerada(s)') : 'Aguardando o 1º ciclo.',
    },
    {
      id: 'daily', nome: 'Daily dos Agentes (resumo por WhatsApp)', categoria: 'ia',
      ativo: daily.ativo, emExecucao: daily.emExecucao, intervaloMs: daily.intervaloMs,
      ultimaExecucaoEm: daily.ultimaExecucaoEm, ultimoCicloOk: daily.ultimoCicloOk,
      resumo: resumoDaily(daily),
    },
  ];

  res.json({ agentes });
});

module.exports = router;
