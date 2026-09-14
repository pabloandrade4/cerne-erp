// Especialista "Promoções" para a Daily dos Agentes — Etapa 2 (14/09/2026).
// Mesmo conceito de lib/ia/especialistaAds.js: reaproveita EXCLUSIVAMENTE as
// decisões pendentes que o agente "Promoções" já gera hoje em produção
// (ia_decisoes_promocoes, ver lib/ia/promocoesDecisor.js/promocoesCiclo.js)
// — nunca recalcula nada, nunca consulta a API do Mercado Livre. Sem
// decisão pendente real, sem achado.
const pool = require('../../db/pool');

const AGENTE_CODIGO = 'promocoes';
const DECISAO_TABELA = 'ia_decisoes_promocoes';

// Mesmo espírito do mapa de Ads: "sair_promocao"/"revisar_preco" reagem a
// uma margem real já comprometida (problema); "entrar_promocao" é uma
// oportunidade real de vender mais com margem validada; "nao_entrar" é um
// risco evitado (a IA identificou que entrar seria ruim) — prioridade
// baixa porque nenhuma ação é necessária, é só um alerta informativo.
const MAPA_ACAO = {
  sair_promocao: { tipo: 'problema', prioridade: 'alta' },
  revisar_preco: { tipo: 'problema', prioridade: 'media' },
  entrar_promocao: { tipo: 'oportunidade', prioridade: 'media' },
  nao_entrar_promocao: { tipo: 'risco', prioridade: 'baixa' },
};

function tituloParaDecisao(d) {
  const alvo = d.titulo || d.sku || d.ml_item_id || `#${d.id}`;
  const acaoLegivel = String(d.tipo_acao || '').replace(/_/g, ' ');
  return `Promoção "${d.promotion_label || d.promotion_type}" em "${alvo}" — ${acaoLegivel}`;
}

async function achadosDeDecisoesPendentes(empresaId) {
  const { rows } = await pool.query(
    `SELECT id, promotion_id, promotion_type, promotion_label, ml_item_id, sku, titulo,
            tipo_acao, motivo, snapshot_preco_normal, snapshot_preco_promo, snapshot_desconto_pct,
            snapshot_margem_real, snapshot_margem_real_pct, valor_sugerido_ia
       FROM ia_decisoes_promocoes
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
        precoNormal: d.snapshot_preco_normal,
        precoPromo: d.snapshot_preco_promo,
        descontoPct: d.snapshot_desconto_pct,
        margemReal: d.snapshot_margem_real,
        margemRealPct: d.snapshot_margem_real_pct,
        valorSugeridoIa: d.valor_sugerido_ia,
      },
      prioridade: mapa.prioridade,
      sku: d.sku,
      campanhaId: null,
      pedidoId: null,
      decisaoTabela: DECISAO_TABELA,
      decisaoId: d.id,
    };
  });
}

// Mesmo mecanismo de "alteração" de lib/ia/especialistaAds.js — decisões
// que estavam pendentes na Daily anterior e que você já decidiu, com o dado
// real da decisão (nunca uma conversa inventada).
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
    `SELECT id, tipo_acao, promotion_label, promotion_type, sku, titulo, status_decisao, decidido_em, valor_decidido_usuario
       FROM ia_decisoes_promocoes
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

async function gerarResumoDiario({ empresaId, reuniaoAnteriorId }) {
  const [problemasEOportunidades, alteracoes] = await Promise.all([
    achadosDeDecisoesPendentes(empresaId),
    achadosDeAlteracoes(reuniaoAnteriorId),
  ]);
  return { achados: [...problemasEOportunidades, ...alteracoes] };
}

module.exports = { AGENTE_CODIGO, gerarResumoDiario, MAPA_ACAO };
