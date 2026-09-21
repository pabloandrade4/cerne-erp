// "Detalhe do Agente" — 20/09/2026, pedido explícito do usuário: "quando
// clicar em cima do agente de ia, quero ver oque ele esta fazendo, oque
// tenho pra aprovar pra ele fazer, oque ele fez e a melhora que ele teve
// naquilo que é pra ser feito". Reaproveita EXCLUSIVAMENTE o que já existe
// (schedulers, ia_decisoes_ads/promocoes, radar_alertas, sac_*) — nenhum
// número novo é calculado do zero aqui além de agregações simples sobre
// dado já real.
//
// 4 seções, sempre nesta ordem (mesma ordem que o usuário pediu):
//   1) statusAtual  — o agendador dessa automação está ativo? de quanto em
//      quanto tempo ele roda? quando rodou pela última vez pra ESSA empresa?
//   2) pendentes    — quantas sugestões esperam sua aprovação agora (só
//      existe pra agentes com um fluxo de decisão — ver `temFluxoDeAprovacao`
//      abaixo; Anúncios e Análise de Concorrente só observam, então nunca
//      têm pendente — isso é dito explicitamente, nunca escondido).
//   3) historico    — últimos eventos reais desse agente (reaproveita
//      lib/ia/agentesResumo.js#listarHistorico, já filtrado por agente).
//   4) melhora      — pedido do usuário respondido em 2 formatos, conforme
//      confirmado por ele: pra Ads/Promoções (que têm decisão + resultado
//      medido depois, ver resultado_snapshot), a melhora real de margem
//      entre o momento da sugestão e a reavaliação automática alguns dias
//      depois; pra Anúncios/Concorrente/SAC (que não têm um "antes/depois"
//      financeiro), a melhora é "quantos alertas/atendimentos foram
//      resolvidos nos últimos 30 dias" — confirmado com o usuário que é
//      isso que ele quer ver pra esses casos.
const pool = require('../../db/pool');
const { listarHistorico } = require('./agentesResumo');

const JANELA_MELHORA_DIAS = 30;

// ---------------- 1) Status atual ----------------
// Cada agente automático já expõe seu próprio obterStatus*() (mesmo padrão
// em lib/adsScheduler.js, lib/ia/promocoesScheduler.js, radarScheduler.js,
// concorrenteScheduler.js, sacScheduler.js) — aqui só escolhemos o certo
// pra cada agente e devolvemos um formato único.
function statusAdsPerformance() {
  const s = require('../adsScheduler').obterStatusSincronizacaoAds();
  return { ativo: s.ativo, intervaloMs: s.intervaloMs, ultimaExecucaoEm: s.ultimaExecucaoEm, ultimoCicloOk: s.ultimoCicloOk };
}
function statusPromocoes() {
  const s = require('./promocoesScheduler').obterStatusScheduler();
  return { ativo: s.ativo, intervaloMs: s.intervaloMs, ultimaExecucaoEm: s.ultimaExecucaoEm, ultimoCicloOk: s.ultimoCicloOk };
}
function statusAnunciosRadar() {
  // Mesmo agendador cuida de Anúncios (anuncio_%) e dos alertas de negócio
  // que ainda não são um agente próprio (ver EM_CONSTRUCAO) — o status é do
  // processo inteiro, não dá pra separar por categoria aqui.
  const s = require('./radarScheduler').obterStatusScheduler();
  return { ativo: s.ativo, intervaloMs: s.intervaloMs, ultimaExecucaoEm: s.ultimaExecucaoEm, ultimoCicloOk: s.ultimoCicloOk };
}
function statusConcorrente() {
  const s = require('./concorrenteScheduler').obterStatusScheduler();
  return { ativo: s.ativo, intervaloMs: s.intervaloMs, ultimaExecucaoEm: s.ultimaExecucaoEm, ultimoCicloOk: s.ultimoCicloOk };
}
function statusSac(marketplace) {
  const s = require('./sacScheduler').obterStatusScheduler();
  const sub = marketplace === 'shopee' ? s.shopee : s.mercadoLivre;
  return { ativo: s.ativo, intervaloMs: s.intervaloMs, ultimaExecucaoEm: s.ultimaExecucaoEm, ultimoCicloOk: sub ? sub.comErro.length === 0 : null };
}

const STATUS_POR_AGENTE = {
  ads_performance: statusAdsPerformance,
  promocoes: statusPromocoes,
  anuncios_radar: statusAnunciosRadar,
  concorrente: statusConcorrente,
  sac_mercado_livre: () => statusSac('mercado_livre'),
  sac_shopee: () => statusSac('shopee'),
};

function obterStatusAtual(agenteCodigo) {
  const fn = STATUS_POR_AGENTE[agenteCodigo];
  return fn ? fn() : null;
}

// ---------------- 2) Pendentes ----------------
// Só os agentes com um fluxo real de aprovar/recusar entram aqui — Anúncios
// e Análise de Concorrente são observação pura (nunca tiveram decisaoTabela
// nos achados da Daily, ver especialistaAnuncios.js/especialistaConcorrente.js).
const TABELA_PENDENTES = {
  ads_performance: 'ia_decisoes_ads',
  promocoes: 'ia_decisoes_promocoes',
};

async function obterPendentes(agenteCodigo, empresaId) {
  if (TABELA_PENDENTES[agenteCodigo]) {
    const { rows } = await pool.query(
      `SELECT count(*) AS total FROM ${TABELA_PENDENTES[agenteCodigo]} WHERE empresa_id = $1 AND status_decisao = 'pendente'`,
      [empresaId]
    );
    return { temFluxoDeAprovacao: true, total: Number(rows[0].total || 0) };
  }
  if (agenteCodigo === 'sac_mercado_livre' || agenteCodigo === 'sac_shopee') {
    const marketplace = agenteCodigo === 'sac_shopee' ? 'shopee' : 'mercado_livre';
    const { rows } = await pool.query(
      `SELECT count(*) AS total
         FROM sac_respostas r JOIN sac_atendimentos a ON a.id = r.atendimento_id
        WHERE a.empresa_id = $1 AND a.marketplace = $2 AND r.status_decisao = 'pendente'`,
      [empresaId, marketplace]
    );
    return { temFluxoDeAprovacao: true, total: Number(rows[0].total || 0) };
  }
  // anuncios_radar / concorrente — nunca inventa um número de pendente
  // onde não existe fluxo de aprovação nenhum.
  return { temFluxoDeAprovacao: false, total: 0 };
}

// ---------------- 3) Histórico ----------------
async function obterHistorico(agenteCodigo, empresaId, limit) {
  return listarHistorico(empresaId, limit || 20, agenteCodigo);
}

// ---------------- 4) Melhora ----------------
// Ads/Promoções: delta real de margem entre o momento da sugestão
// (snapshot_*, "antes") e a reavaliação automática feita alguns dias depois
// da decisão (resultado_snapshot, "depois" — ver lib/ia/adsDecisoesCiclo.js/
// promocoesDecisoesStore.js). Sem nenhuma decisão já avaliada, devolve
// `avaliadas: 0` — nunca uma média calculada sobre lista vazia.
async function melhoraAds(empresaId) {
  const { rows } = await pool.query(
    `SELECT snapshot_margem_depois_ads_pct AS antes,
            (resultado_snapshot->>'margemDepoisDoAdsPct')::numeric AS depois
       FROM ia_decisoes_ads
      WHERE empresa_id = $1 AND status_decisao IN ('aprovada','alterada') AND resultado_avaliado_em IS NOT NULL`,
    [empresaId]
  );
  return calcularMelhoraFinanceira(rows);
}
async function melhoraPromocoes(empresaId) {
  const { rows } = await pool.query(
    `SELECT snapshot_margem_real_pct AS antes,
            (resultado_snapshot->>'margemRealPct')::numeric AS depois
       FROM ia_decisoes_promocoes
      WHERE empresa_id = $1 AND status_decisao IN ('aprovada','alterada') AND resultado_avaliado_em IS NOT NULL`,
    [empresaId]
  );
  return calcularMelhoraFinanceira(rows);
}
function calcularMelhoraFinanceira(rows) {
  const comAmbos = rows.filter((r) => r.antes !== null && r.depois !== null);
  if (!comAmbos.length) return { tipo: 'financeira', avaliadas: 0, deltaMedioPct: null };
  const soma = comAmbos.reduce((acc, r) => acc + (Number(r.depois) - Number(r.antes)), 0);
  return { tipo: 'financeira', avaliadas: comAmbos.length, deltaMedioPct: Math.round((soma / comAmbos.length) * 100) / 100 };
}

// Anúncios/Concorrente/SAC: "quantos alertas/atendimentos ele resolveu nos
// últimos 30 dias" — confirmado com o usuário como o significado de
// "melhora" pra agentes que só observam (sem decisão financeira própria
// pra medir antes/depois).
async function melhoraPorResolucao({ tabela, whereExtra, resolvidoExpr, abertoExpr, params }) {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE ${resolvidoExpr} >= now() - interval '${JANELA_MELHORA_DIAS} days') AS resolvidos_ultimos_30d,
       count(*) FILTER (WHERE ${abertoExpr}) AS abertos_agora
     FROM ${tabela} WHERE ${whereExtra}`,
    params
  );
  const r = rows[0] || {};
  return {
    tipo: 'resolucao',
    resolvidosUltimos30d: Number(r.resolvidos_ultimos_30d || 0),
    abertosAgora: Number(r.abertos_agora || 0),
  };
}

async function melhoraAnunciosRadar(empresaId) {
  return melhoraPorResolucao({
    tabela: 'radar_alertas',
    whereExtra: "empresa_id = $1 AND categoria LIKE 'anuncio_%'",
    resolvidoExpr: 'resolvido_em',
    abertoExpr: "status = 'aberto'",
    params: [empresaId],
  });
}
async function melhoraConcorrente(empresaId) {
  return melhoraPorResolucao({
    tabela: 'radar_alertas',
    whereExtra: "empresa_id = $1 AND categoria = 'concorrente_ativo'",
    resolvidoExpr: 'resolvido_em',
    abertoExpr: "status = 'aberto'",
    params: [empresaId],
  });
}
async function melhoraSac(empresaId, marketplace) {
  return melhoraPorResolucao({
    tabela: 'sac_atendimentos',
    whereExtra: 'empresa_id = $1 AND marketplace = $2',
    resolvidoExpr: 'atualizado_em',
    abertoExpr: "status IN ('novo','aguardando_resposta')",
    params: [empresaId, marketplace],
  }).then(async (base) => {
    // "resolvido" pra um atendimento é status IN ('respondido','resolvido')
    // — o filtro acima usa `atualizado_em` como proxy de "quando resolveu"
    // (a tabela não guarda um `resolvido_em` próprio), então restringe
    // também pelo status atual pra não contar um aberto que só foi tocado
    // recentemente (ex.: nova mensagem do cliente reabrindo o caso).
    const { rows } = await pool.query(
      `SELECT count(*) AS total FROM sac_atendimentos
        WHERE empresa_id = $1 AND marketplace = $2 AND status IN ('respondido','resolvido')
          AND atualizado_em >= now() - interval '${JANELA_MELHORA_DIAS} days'`,
      [empresaId, marketplace]
    );
    return { ...base, resolvidosUltimos30d: Number(rows[0].total || 0) };
  });
}

async function obterMelhora(agenteCodigo, empresaId) {
  switch (agenteCodigo) {
    case 'ads_performance': return melhoraAds(empresaId);
    case 'promocoes': return melhoraPromocoes(empresaId);
    case 'anuncios_radar': return melhoraAnunciosRadar(empresaId);
    case 'concorrente': return melhoraConcorrente(empresaId);
    case 'sac_mercado_livre': return melhoraSac(empresaId, 'mercado_livre');
    case 'sac_shopee': return melhoraSac(empresaId, 'shopee');
    default: return null;
  }
}

// ---------------- Combinação ----------------
async function obterDetalheAgente(agenteCodigo, empresaId) {
  const [pendentes, historico, melhora] = await Promise.all([
    obterPendentes(agenteCodigo, empresaId),
    obterHistorico(agenteCodigo, empresaId, 20),
    obterMelhora(agenteCodigo, empresaId),
  ]);
  return {
    agenteCodigo,
    statusAtual: obterStatusAtual(agenteCodigo),
    pendentes,
    historico,
    melhora,
  };
}

module.exports = { obterDetalheAgente, obterStatusAtual, obterPendentes, obterHistorico, obterMelhora };
