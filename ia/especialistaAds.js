// Especialista "Ads e Performance" para a Daily dos Agentes — Etapa 2
// (14/09/2026, pedido explícito do usuário: evoluir a arquitetura dos
// agentes de IA por etapas, começando pela fundação da "Daily dos
// Agentes"). Implementa o contrato gerarResumoDiario (ver
// lib/ia/especialistas.js) reaproveitando EXCLUSIVAMENTE dados que o
// agente "Ads e Performance" já calcula hoje em produção — as decisões
// pendentes geradas por lib/ia/adsDecisoesCiclo.js/lib/ia/adsDecisor.js.
//
// Este arquivo NUNCA recalcula classificação nem consulta a API do
// Mercado Livre — só lê o que já existe (ia_decisoes_ads) e organiza em
// achados. Sem decisão pendente real, sem achado — nunca inventa nada pra
// preencher a Daily.
const pool = require('../../db/pool');

const AGENTE_CODIGO = 'ads_performance';
const DECISAO_TABELA = 'ia_decisoes_ads';

// Mapeamento determinístico tipo_acao -> {tipo do achado, prioridade}.
// Critério simples e explicável nesta primeira versão: uma ação que reage a
// um resultado JÁ NEGATIVO (pausar) é "problema" com prioridade "alta";
// reduzir orçamento por margem positiva mas abaixo do mínimo configurado é
// "problema" com prioridade "média"; ações de crescimento (aumentar
// orçamento, reativar campanha, considerar entrar em campanha) são
// "oportunidade". Estes critérios podem ser refinados mais pra frente com
// dado real de impacto financeiro, quando o período de aprendizado (40
// dias) começar a gerar histórico — nunca antes disso.
const MAPA_ACAO = {
  pausar_anuncio: { tipo: 'problema', prioridade: 'alta' },
  pausar_campanha: { tipo: 'problema', prioridade: 'alta' },
  diminuir_orcamento: { tipo: 'problema', prioridade: 'media' },
  aumentar_orcamento: { tipo: 'oportunidade', prioridade: 'media' },
  ativar_campanha: { tipo: 'oportunidade', prioridade: 'media' },
  colocar_sku_em_campanha: { tipo: 'oportunidade', prioridade: 'baixa' },
};

function tituloParaDecisao(d) {
  const alvo = d.campanha_nome || d.titulo || d.sku || d.ml_item_id || `#${d.id}`;
  const acaoLegivel = String(d.tipo_acao || '').replace(/_/g, ' ');
  const rotulo = d.tipo_referencia === 'campanha' ? 'Campanha' : 'Anúncio';
  return `${rotulo} "${alvo}" — ${acaoLegivel}`;
}

// Achados de PROBLEMA/OPORTUNIDADE: toda decisão pendente de hoje do agente
// Ads — dado 100% real, já validado pelo decisor determinístico existente
// (mesma linha que aparece na aba "Pendentes" da tela de Ads e Performance).
async function achadosDeDecisoesPendentes(empresaId) {
  const { rows } = await pool.query(
    `SELECT id, tipo_referencia, ml_item_id, campanha_id, campanha_nome, sku, titulo,
            tipo_acao, motivo, snapshot_margem_depois_ads, snapshot_margem_depois_ads_pct,
            snapshot_orcamento_atual, snapshot_roas, snapshot_acos, valor_sugerido_ia
       FROM ia_decisoes_ads
      WHERE empresa_id = $1 AND status_decisao = 'pendente'
      ORDER BY atualizado_em DESC`,
    [empresaId]
  );
  return rows.map((d) => {
    const mapa = MAPA_ACAO[d.tipo_acao] || { tipo: 'oportunidade', prioridade: 'baixa' };
    return {
      tipo: mapa.tipo,
      titulo: tituloParaDecisao(d),
      descricao: d.motivo,
      dados: {
        // `tipoAcao` (20/09/2026) — adicionado especificamente pro Agente
        // Coordenador (lib/ia/coordenadorDiario.js, regra R1) conseguir
        // identificar de forma direta e auditável (nunca por um proxy
        // indireto tipo/prioridade) quando a ação sugerida foi pausar
        // anúncio/campanha, pra cruzar com queda de vendas do mesmo SKU.
        tipoAcao: d.tipo_acao,
        margemDepoisDoAds: d.snapshot_margem_depois_ads,
        margemDepoisDoAdsPct: d.snapshot_margem_depois_ads_pct,
        orcamentoAtual: d.snapshot_orcamento_atual,
        roas: d.snapshot_roas,
        acos: d.snapshot_acos,
        valorSugeridoIa: d.valor_sugerido_ia,
      },
      prioridade: mapa.prioridade,
      sku: d.sku,
      campanhaId: d.campanha_id,
      pedidoId: null,
      decisaoTabela: DECISAO_TABELA,
      decisaoId: d.id,
    };
  });
}

// Achados de ALTERAÇÃO: decisões que estavam pendentes (e viraram achado) na
// ÚLTIMA Daily e que você já decidiu desde então (aprovou/alterou/recusou) —
// dado real (status_decisao/decidido_em/valor_decidido_usuario), nunca um
// resumo de conversa inventado. Sem reunião anterior, não há o que comparar
// — lista vazia, nunca um achado fabricado.
async function achadosDeAlteracoes(reuniaoAnteriorId) {
  if (!reuniaoAnteriorId) return [];
  const { rows: achadosAnteriores } = await pool.query(
    `SELECT DISTINCT decisao_id FROM ia_achados_diarios
      WHERE reuniao_id = $1 AND agente_codigo = $2 AND decisao_tabela = $3 AND decisao_id IS NOT NULL`,
    [reuniaoAnteriorId, AGENTE_CODIGO, DECISAO_TABELA]
  );
  const idsAnteriores = achadosAnteriores.map((r) => r.decisao_id);
  if (!idsAnteriores.length) return [];

  const { rows: decididas } = await pool.query(
    `SELECT id, tipo_acao, campanha_nome, sku, titulo, status_decisao, decidido_em, valor_decidido_usuario
       FROM ia_decisoes_ads
      WHERE id = ANY($1::int[]) AND status_decisao <> 'pendente'`,
    [idsAnteriores]
  );
  return decididas.map((d) => ({
    tipo: 'alteracao',
    titulo: `${tituloParaDecisao(d)} — você registrou "${d.status_decisao}"`,
    descricao: d.decidido_em
      ? `Decisão registrada em ${new Date(d.decidido_em).toLocaleString('pt-BR')}.`
      : 'Decisão já registrada (data indisponível).',
    dados: { statusDecisao: d.status_decisao, valorDecididoUsuario: d.valor_decidido_usuario },
    prioridade: null,
    sku: d.sku,
    campanhaId: null,
    pedidoId: null,
    decisaoTabela: DECISAO_TABELA,
    decisaoId: d.id,
  }));
}

// Contrato do especialista — ver lib/ia/especialistas.js. `dataReferencia`
// não é usado nesta primeira versão (as decisões pendentes já refletem o
// estado mais atual, não há necessidade de filtrar por data), mas fica no
// contrato para os especialistas futuros que precisarem dele (ex.: SAC
// pode precisar do dia exato pra filtrar reclamações novas).
async function gerarResumoDiario({ empresaId, reuniaoAnteriorId }) {
  const [problemasEOportunidades, alteracoes] = await Promise.all([
    achadosDeDecisoesPendentes(empresaId),
    achadosDeAlteracoes(reuniaoAnteriorId),
  ]);
  return { achados: [...problemasEOportunidades, ...alteracoes] };
}

module.exports = { AGENTE_CODIGO, gerarResumoDiario, MAPA_ACAO };
