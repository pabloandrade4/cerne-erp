// Resumo/KPIs e Histórico da tela "Agentes de IA" (hub) — 14/09/2026,
// ETAPA 2/3 do pedido do usuário de redesenhar essa área
// ("NÃO USAR DADOS FALSOS" — regra 3 do pedido). Router fino em
// routes/iaAgentes.js chama só as funções daqui, mesmo padrão de
// routes/alertas.js -> lib/ia/radar.js.
//
// TODO NÚMERO AQUI VEM DE TABELA QUE JÁ EXISTE E JÁ É PREENCHIDA pelos
// ciclos automáticos reais (ia_decisoes_ads/ia_decisoes_promocoes via
// lib/ia/adsDecisoesCiclo.js e promoções, radar_alertas via
// lib/ia/radarScheduler.js, ia_conversas/ia_mensagens via
// routes/iaGestora.js) — nunca um cálculo novo, nunca um placeholder.
// Quando não há dado, o número vem 0/null e o front-end mostra "Sem dados
// ainda" (ver window.AgentesIaHub em public/index.html).
const pool = require('../../db/pool');
const { obterRadarParaEmpresa } = require('./radar');
const sacStore = require('./sacStore');

const HISTORICO_LIMITE_PADRAO = 40;
const HISTORICO_LIMITE_MAX = 200;

async function statsAgentesDecisoes(tabela, empresaId) {
  // `tabela` nunca vem de entrada do usuário — só é chamada com os 2
  // literais fixos abaixo ('ia_decisoes_ads'/'ia_decisoes_promocoes'),
  // nunca com req.query/req.body.
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status_decisao = 'pendente')      AS pendentes,
       count(*) FILTER (WHERE decidido_em::date = CURRENT_DATE) AS decididas_hoje,
       count(*) FILTER (WHERE criado_em::date = CURRENT_DATE)   AS sugestoes_novas_hoje,
       max(atualizado_em)                                       AS ultima_atualizacao
     FROM ${tabela} WHERE empresa_id = $1`,
    [empresaId]
  );
  const r = rows[0] || {};
  return {
    pendentes: Number(r.pendentes || 0),
    decididasHoje: Number(r.decididas_hoje || 0),
    sugestoesNovasHoje: Number(r.sugestoes_novas_hoje || 0),
    ultimaAtualizacao: r.ultima_atualizacao || null,
  };
}

async function statsIaGestora(empresaId) {
  const { rows } = await pool.query(
    `SELECT count(*) AS mensagens_hoje,
            count(DISTINCT m.conversa_id) AS conversas_hoje,
            max(m.criado_em) AS ultima_atividade
     FROM ia_mensagens m
     JOIN ia_conversas c ON c.id = m.conversa_id
     WHERE c.empresa_id = $1 AND m.criado_em::date = CURRENT_DATE`,
    [empresaId]
  );
  const r = rows[0] || {};
  return {
    mensagensHoje: Number(r.mensagens_hoje || 0),
    conversasHoje: Number(r.conversas_hoje || 0),
    ultimaAtividade: r.ultima_atividade || null,
  };
}

async function contarAlertasNovosHoje(empresaId) {
  const { rows } = await pool.query(
    `SELECT count(*) AS total FROM radar_alertas WHERE empresa_id = $1 AND criado_em::date = CURRENT_DATE`,
    [empresaId]
  );
  return Number((rows[0] && rows[0].total) || 0);
}

// GET /api/ia-agentes/stats?empresaId=ID
async function obterResumoHub(empresaId) {
  const [{ rows: agentesRows }, ads, promocoes, sacMl, sacShopee, iaGestora, alertasNovosHoje, radar] = await Promise.all([
    pool.query('SELECT codigo, nome, descricao, icone FROM ia_agentes WHERE ativo = true ORDER BY ordem, id'),
    statsAgentesDecisoes('ia_decisoes_ads', empresaId),
    statsAgentesDecisoes('ia_decisoes_promocoes', empresaId),
    // SAC (14/09/2026) — mesmo formato {pendentes, decididasHoje,
    // sugestoesNovasHoje, ultimaAtualizacao} de statsAgentesDecisoes acima
    // (ver lib/ia/sacStore.js#estatisticasAgente).
    sacStore.estatisticasAgente(empresaId, 'mercado_livre'),
    sacStore.estatisticasAgente(empresaId, 'shopee'),
    statsIaGestora(empresaId),
    contarAlertasNovosHoje(empresaId),
    obterRadarParaEmpresa(empresaId),
  ]);

  const statsPorCodigo = { ads_performance: ads, promocoes, sac_mercado_livre: sacMl, sac_shopee: sacShopee };

  // "Tarefas executadas hoje" = soma do que cada mecanismo automático real
  // já fez hoje: novas sugestões geradas pelos agentes de decisão (Ads e
  // Performance + Promoções + os 2 agentes de SAC) + novos alertas
  // detectados pelo Radar. É uma soma de fontes diferentes de propósito
  // (nenhuma delas sozinha representa "o que os agentes fizeram hoje") —
  // nunca inclui nada que a IA ainda não fez de verdade (aprovações são
  // AÇÃO DO USUÁRIO, não do agente, por isso não entram aqui).
  const tarefasHoje = ads.sugestoesNovasHoje + promocoes.sugestoesNovasHoje
    + sacMl.sugestoesNovasHoje + sacShopee.sugestoesNovasHoje + alertasNovosHoje;

  return {
    kpis: {
      agentesAtivos: agentesRows.length,
      tarefasHoje,
      alertasImportantes: radar.contagem.critico + radar.contagem.atencao,
    },
    agentes: agentesRows.map((a) => ({
      codigo: a.codigo,
      nome: a.nome,
      descricao: a.descricao,
      icone: a.icone,
      ...(statsPorCodigo[a.codigo] || { pendentes: 0, decididasHoje: 0, sugestoesNovasHoje: 0, ultimaAtualizacao: null }),
    })),
    iaGestora,
    alertasHoje: alertasNovosHoje,
  };
}

// GET /api/ia-agentes/historico?empresaId=ID&limit=N — eventos REAIS, nunca
// fabricados: "sugeriu" (criado_em de uma situação nova em
// ia_decisoes_ads/ia_decisoes_promocoes), a decisão do usuário sobre ela
// (decidido_em) e alertas novos do Radar (criado_em em radar_alertas).
// NUNCA inclui um 3º evento de "enviado ao Mercado Livre" — `executado`
// ainda é sempre false nesta fase (nenhuma escrita automática acontece).
async function listarHistorico(empresaId, limit) {
  const lim = Math.min(Math.max(Number(limit) || HISTORICO_LIMITE_PADRAO, 1), HISTORICO_LIMITE_MAX);
  const { rows } = await pool.query(
    `(
       SELECT criado_em AS ts, 'ads_performance'::text AS agente_codigo, 'sugestao'::text AS tipo,
              COALESCE(titulo, campanha_nome, 'Campanha')::text AS referencia,
              tipo_acao::text AS tipo_acao, motivo::text AS motivo,
              NULL::text AS usuario, NULL::text AS extra
       FROM ia_decisoes_ads WHERE empresa_id = $1
     )
     UNION ALL
     (
       SELECT decidido_em AS ts, 'ads_performance'::text AS agente_codigo, status_decisao::text AS tipo,
              COALESCE(titulo, campanha_nome, 'Campanha')::text AS referencia,
              tipo_acao::text AS tipo_acao, motivo::text AS motivo,
              decidido_por::text AS usuario, NULL::text AS extra
       FROM ia_decisoes_ads WHERE empresa_id = $1 AND decidido_em IS NOT NULL
     )
     UNION ALL
     (
       SELECT criado_em AS ts, 'promocoes'::text AS agente_codigo, 'sugestao'::text AS tipo,
              COALESCE(titulo, 'Anúncio')::text AS referencia,
              tipo_acao::text AS tipo_acao, motivo::text AS motivo,
              NULL::text AS usuario, NULL::text AS extra
       FROM ia_decisoes_promocoes WHERE empresa_id = $1
     )
     UNION ALL
     (
       SELECT decidido_em AS ts, 'promocoes'::text AS agente_codigo, status_decisao::text AS tipo,
              COALESCE(titulo, 'Anúncio')::text AS referencia,
              tipo_acao::text AS tipo_acao, motivo::text AS motivo,
              decidido_por::text AS usuario, NULL::text AS extra
       FROM ia_decisoes_promocoes WHERE empresa_id = $1 AND decidido_em IS NOT NULL
     )
     UNION ALL
     (
       SELECT criado_em AS ts, 'radar'::text AS agente_codigo, 'alerta'::text AS tipo,
              titulo::text AS referencia, categoria::text AS tipo_acao, descricao::text AS motivo,
              NULL::text AS usuario, severidade::text AS extra
       FROM radar_alertas WHERE empresa_id = $1
     )
     UNION ALL
     (
       -- SAC (14/09/2026) — atendimento novo/reaberto (ver
       -- lib/ia/sacStore.js#upsertAtendimento). agente_codigo varia por
       -- marketplace: sac_mercado_livre ou sac_shopee.
       SELECT criado_em AS ts,
              ('sac_' || CASE WHEN marketplace = 'shopee' THEN 'shopee' ELSE 'mercado_livre' END)::text AS agente_codigo,
              'atendimento_novo'::text AS tipo,
              COALESCE(produto_titulo, cliente_nome, 'Atendimento')::text AS referencia,
              tipo_origem::text AS tipo_acao, LEFT(mensagem_cliente, 200)::text AS motivo,
              NULL::text AS usuario, marketplace::text AS extra
       FROM sac_atendimentos WHERE empresa_id = $1
     )
     UNION ALL
     (
       -- decisão do usuário sobre a sugestão de resposta (aprovar/editar/
       -- recusar) — nunca um evento de "enviado ao cliente" (enviado é
       -- sempre false nesta fase, ver db/schema.sql).
       SELECT r.decidido_em AS ts,
              ('sac_' || CASE WHEN a.marketplace = 'shopee' THEN 'shopee' ELSE 'mercado_livre' END)::text AS agente_codigo,
              r.status_decisao::text AS tipo,
              COALESCE(a.produto_titulo, a.cliente_nome, 'Atendimento')::text AS referencia,
              a.tipo_origem::text AS tipo_acao, NULL::text AS motivo,
              r.decidido_por::text AS usuario, a.marketplace::text AS extra
       FROM sac_respostas r JOIN sac_atendimentos a ON a.id = r.atendimento_id
       WHERE a.empresa_id = $1 AND r.decidido_em IS NOT NULL
     )
     ORDER BY ts DESC
     LIMIT $2`,
    [empresaId, lim]
  );
  return rows.map((r) => ({
    ts: r.ts,
    agenteCodigo: r.agente_codigo,
    tipo: r.tipo,
    referencia: r.referencia,
    tipoAcao: r.tipo_acao,
    motivo: r.motivo,
    usuario: r.usuario,
    extra: r.extra,
  }));
}

module.exports = { obterResumoHub, listarHistorico };
