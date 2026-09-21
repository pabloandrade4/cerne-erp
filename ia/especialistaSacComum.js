// Base compartilhada dos especialistas de SAC (Mercado Livre e Shopee) para a
// Daily dos Agentes — 20/09/2026, pedido explícito do usuário: "quero
// agentes dessa forma... e sobre os relatórios quero que me mande todo dia
// às 7 horas". SAC tinha ficado de fora da Daily desde a Etapa 4
// (19/09/2026) por decisão combinada de deixar pra uma próxima etapa — esta
// é essa etapa.
//
// Mesmo espírito de especialistaAds.js: NUNCA classifica/gera nada aqui —
// só lê o que os agentes de SAC (lib/ia/sacCiclo.js + lib/ia/sacRespostaIa.js)
// já persistiram em sac_atendimentos/sac_respostas e organiza em achados.
// Sem atendimento com sugestão pendente real, sem achado — nunca inventa.
//
// `sac_mercado_livre` e `sac_shopee` são dois agentes SEPARADOS no catálogo
// (ver db/schema.sql, ia_agentes) — este módulo é só a lógica comum,
// parametrizada por `marketplace`; cada wrapper (especialistaSacMercadoLivre.js/
// especialistaSacShopee.js) informa seu próprio AGENTE_CODIGO/marketplace,
// exatamente como o resto da Daily espera (ver lib/ia/especialistas.js).
const pool = require('../../db/pool');

const DECISAO_TABELA = 'sac_respostas';

// Critério determinístico e explicável, no mesmo espírito de
// especialistaAds.js#MAPA_ACAO: urgência marcada pelo próprio ciclo de SAC
// (lib/ia/sacRespostaIa.js) manda mais que a classificação; reclamação,
// insatisfação, problema de entrega e devolução são sempre "problema" (o
// cliente já está com um caso real em aberto); dúvida simples ou pergunta
// pré-venda vira "risco" de prioridade baixa — não é um problema em si, mas
// demorar pra responder pode custar a venda.
function classificarAchado(atendimento) {
  if (atendimento.urgente) return { tipo: 'problema', prioridade: 'alta' };
  if (['reclamacao', 'insatisfeito', 'problema_entrega'].includes(atendimento.classificacao)) {
    return { tipo: 'problema', prioridade: 'media' };
  }
  if (atendimento.tipo_origem === 'devolucao') return { tipo: 'problema', prioridade: 'media' };
  return { tipo: 'risco', prioridade: 'baixa' };
}

const ORIGEM_LEGIVEL = {
  pergunta: 'Pergunta',
  mensagem: 'Mensagem pós-venda',
  reclamacao: 'Reclamação',
  devolucao: 'Devolução',
};

function tituloDoAtendimento(a) {
  const origem = ORIGEM_LEGIVEL[a.tipo_origem] || a.tipo_origem;
  const alvo = a.produto_titulo || a.sku || a.pedido_ref || `#${a.id}`;
  const cliente = a.cliente_nome ? ` — ${a.cliente_nome}` : '';
  return `${origem}: "${alvo}"${cliente}`;
}

async function achadosDeSugestoesPendentes(empresaId, marketplace) {
  const { rows } = await pool.query(
    `SELECT sa.id, sa.tipo_origem, sa.pedido_ref, sa.sku, sa.produto_titulo, sa.cliente_nome,
            sa.mensagem_cliente, sa.status, sa.classificacao, sa.urgente, sa.data_recebido,
            sr.id AS resposta_id, sr.resposta_sugerida_ia, sr.motivo_sem_sugestao
       FROM sac_atendimentos sa
       JOIN sac_respostas sr ON sr.atendimento_id = sa.id AND sr.status_decisao = 'pendente'
      WHERE sa.empresa_id = $1 AND sa.marketplace = $2
      ORDER BY sa.urgente DESC, sa.data_recebido DESC`,
    [empresaId, marketplace]
  );
  return rows.map((a) => {
    const mapa = classificarAchado(a);
    return {
      tipo: mapa.tipo,
      titulo: tituloDoAtendimento(a),
      descricao: a.mensagem_cliente,
      dados: {
        status: a.status,
        classificacao: a.classificacao,
        urgente: a.urgente,
        respostaSugeridaIa: a.resposta_sugerida_ia,
        motivoSemSugestao: a.motivo_sem_sugestao,
      },
      prioridade: mapa.prioridade,
      sku: a.sku,
      campanhaId: null,
      pedidoId: a.pedido_ref,
      decisaoTabela: DECISAO_TABELA,
      decisaoId: a.resposta_id,
    };
  });
}

// Achados de ALTERAÇÃO: sugestões que estavam pendentes na Daily anterior e
// que você já decidiu desde então (aprovou/editou/recusou) — mesmo padrão
// de especialistaAds.js#achadosDeAlteracoes. Sem reunião anterior, lista
// vazia (nunca inventa comparação).
async function achadosDeAlteracoes(reuniaoAnteriorId, agenteCodigo) {
  if (!reuniaoAnteriorId) return [];
  const { rows: achadosAnteriores } = await pool.query(
    `SELECT DISTINCT decisao_id FROM ia_achados_diarios
      WHERE reuniao_id = $1 AND agente_codigo = $2 AND decisao_tabela = $3 AND decisao_id IS NOT NULL`,
    [reuniaoAnteriorId, agenteCodigo, DECISAO_TABELA]
  );
  const idsAnteriores = achadosAnteriores.map((r) => r.decisao_id);
  if (!idsAnteriores.length) return [];

  const { rows: decididas } = await pool.query(
    `SELECT sr.id, sr.status_decisao, sr.decidido_em, sr.resposta_final,
            sa.tipo_origem, sa.produto_titulo, sa.sku, sa.pedido_ref, sa.cliente_nome
       FROM sac_respostas sr
       JOIN sac_atendimentos sa ON sa.id = sr.atendimento_id
      WHERE sr.id = ANY($1::int[]) AND sr.status_decisao <> 'pendente'`,
    [idsAnteriores]
  );
  return decididas.map((d) => ({
    tipo: 'alteracao',
    titulo: `${tituloDoAtendimento(d)} — você registrou "${d.status_decisao}"`,
    descricao: d.decidido_em
      ? `Decisão registrada em ${new Date(d.decidido_em).toLocaleString('pt-BR')}.`
      : 'Decisão já registrada (data indisponível).',
    dados: { statusDecisao: d.status_decisao, respostaFinal: d.resposta_final },
    prioridade: null,
    sku: d.sku,
    campanhaId: null,
    pedidoId: d.pedido_ref,
    decisaoTabela: DECISAO_TABELA,
    decisaoId: d.id,
  }));
}

// Fábrica usada pelos dois wrappers (um por marketplace) — cada um chama
// isso com seu próprio AGENTE_CODIGO/marketplace real (ver
// especialistaSacMercadoLivre.js/especialistaSacShopee.js).
function criarEspecialistaSac({ agenteCodigo, marketplace }) {
  async function gerarResumoDiario({ empresaId, reuniaoAnteriorId }) {
    const [pendentes, alteracoes] = await Promise.all([
      achadosDeSugestoesPendentes(empresaId, marketplace),
      achadosDeAlteracoes(reuniaoAnteriorId, agenteCodigo),
    ]);
    return { achados: [...pendentes, ...alteracoes] };
  }
  return { AGENTE_CODIGO: agenteCodigo, gerarResumoDiario };
}

module.exports = { criarEspecialistaSac, classificarAchado, tituloDoAtendimento };
