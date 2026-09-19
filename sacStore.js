// Acesso ao banco dos agentes de SAC (Mercado Livre e Shopee) —
// 14/09/2026, pedido explícito do usuário ("vem diretamente do mercado
// livre e shopee... por enquanto vai ser apenas leitura e analise... deve
// ter um agente para shopee e outro para o mercado livre"). Mesmo padrão
// de lib/ia/promocoesDecisoesStore.js/lib/ia/adsDecisoesCiclo.js: SELECT a
// situação pendente antes de gravar, nunca ON CONFLICT DO UPDATE — fica
// explícito no código quando é uma atualização e quando é uma linha nova.
//
// IMPORTANTE (mesma regra 3 do pedido do usuário — "não crie dados
// falsos"): `enviado` em sac_respostas fica SEMPRE false nesta fase —
// nenhuma resposta é transmitida ao Mercado Livre/Shopee. Aprovar aqui só
// REGISTRA a decisão, pro agente aprender o padrão de atendimento (ver
// lib/ia/sacRespostaIa.js e o comentário completo em db/schema.sql).
const pool = require('../../db/pool');

const MARKETPLACES = ['mercado_livre', 'shopee'];
const AGENTE_POR_MARKETPLACE = { mercado_livre: 'sac_mercado_livre', shopee: 'sac_shopee' };

function assertMarketplace(marketplace) {
  if (!MARKETPLACES.includes(marketplace)) {
    throw new Error(`marketplace inválido: "${marketplace}" (use mercado_livre ou shopee).`);
  }
}

// Grava/atualiza UM atendimento (pergunta, mensagem, reclamação ou
// devolução). `item` já vem normalizado por lib/ia/sacMercadoLivre.js ou
// lib/ia/sacShopee.js — a forma é sempre a mesma independente do
// marketplace:
//   { tipoOrigem, idExterno, pedidoRef, sku, produtoTitulo, clienteNome,
//     clienteIdExterno, mensagemCliente, dataRecebido (Date/ISO), raw }
//
// Uma situação em aberto mantém UMA linha só (chave natural: empresa +
// marketplace + tipo_origem + id_externo). Só atualiza mensagem_cliente/
// data_recebido/status quando a mensagem é GENUINAMENTE mais nova que a já
// gravada — e reabre (`status = 'novo'`) um atendimento que já estava
// respondido/resolvido quando isso acontece, pra ele voltar a aparecer na
// caixa de entrada. Devolve { id, ehSituacaoNova } — `ehSituacaoNova` diz
// pra lib/ia/sacCiclo.js se vale a pena gerar uma sugestão de resposta nova.
async function upsertAtendimento(empresaId, marketplace, contaId, item) {
  assertMarketplace(marketplace);
  const dataRecebido = item.dataRecebido instanceof Date ? item.dataRecebido : new Date(item.dataRecebido);

  const existente = await pool.query(
    `SELECT id, status, data_recebido FROM sac_atendimentos
      WHERE empresa_id = $1 AND marketplace = $2 AND tipo_origem = $3 AND id_externo = $4`,
    [empresaId, marketplace, item.tipoOrigem, item.idExterno]
  );

  if (existente.rows.length) {
    const row = existente.rows[0];
    const ehMaisNova = dataRecebido.getTime() > new Date(row.data_recebido).getTime();
    const reabrindo = ehMaisNova && (row.status === 'respondido' || row.status === 'resolvido');

    await pool.query(
      `UPDATE sac_atendimentos SET
         conta_id = $1, pedido_ref = COALESCE($2, pedido_ref), sku = COALESCE($3, sku),
         produto_titulo = COALESCE($4, produto_titulo), cliente_nome = COALESCE($5, cliente_nome),
         cliente_id_externo = COALESCE($6, cliente_id_externo),
         mensagem_cliente = CASE WHEN $7 THEN $8 ELSE mensagem_cliente END,
         data_recebido = CASE WHEN $7 THEN $9 ELSE data_recebido END,
         status = CASE WHEN $10 THEN 'novo' ELSE status END,
         raw_atendimento = COALESCE($11, raw_atendimento),
         atualizado_em = now()
       WHERE id = $12`,
      [
        contaId, item.pedidoRef || null, item.sku || null, item.produtoTitulo || null,
        item.clienteNome || null, item.clienteIdExterno || null,
        ehMaisNova, item.mensagemCliente, dataRecebido.toISOString(),
        reabrindo,
        item.raw ? JSON.stringify(item.raw) : null,
        row.id,
      ]
    );
    return { id: row.id, ehSituacaoNova: ehMaisNova };
  }

  const { rows } = await pool.query(
    `INSERT INTO sac_atendimentos (
       empresa_id, marketplace, conta_id, tipo_origem, id_externo, pedido_ref, sku, produto_titulo,
       cliente_nome, cliente_id_externo, mensagem_cliente, data_recebido, status, raw_atendimento
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'novo',$13)
     RETURNING id`,
    [
      empresaId, marketplace, contaId, item.tipoOrigem, item.idExterno, item.pedidoRef || null,
      item.sku || null, item.produtoTitulo || null, item.clienteNome || null, item.clienteIdExterno || null,
      item.mensagemCliente, dataRecebido.toISOString(), item.raw ? JSON.stringify(item.raw) : null,
    ]
  );
  return { id: rows[0].id, ehSituacaoNova: true };
}

// Grava a sugestão da IA pra um atendimento (ver lib/ia/sacRespostaIa.js).
// Mesmo padrão de "uma pendente por vez": se já existe uma sugestão
// pendente pra esse atendimento, só atualiza o texto sugerido (nunca cria
// uma segunda linha pendente — o índice único parcial garante isso). Marca
// o atendimento como 'aguardando_resposta' e grava a classificação/nível
// de urgência sugeridos.
async function upsertSugestaoPendente(atendimentoId, sugestao) {
  const existente = await pool.query(
    `SELECT id FROM sac_respostas WHERE atendimento_id = $1 AND status_decisao = 'pendente'`,
    [atendimentoId]
  );

  if (existente.rows.length) {
    await pool.query(
      `UPDATE sac_respostas SET resposta_sugerida_ia = $1, motivo_sem_sugestao = $2, atualizado_em = now() WHERE id = $3`,
      [sugestao.respostaSugeridaIa || null, sugestao.motivoSemSugestao || null, existente.rows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO sac_respostas (atendimento_id, resposta_sugerida_ia, motivo_sem_sugestao)
       VALUES ($1, $2, $3)`,
      [atendimentoId, sugestao.respostaSugeridaIa || null, sugestao.motivoSemSugestao || null]
    );
  }

  await pool.query(
    `UPDATE sac_atendimentos SET
       classificacao = COALESCE($1, classificacao), urgente = COALESCE($2, urgente),
       status = CASE WHEN status = 'novo' THEN 'aguardando_resposta' ELSE status END,
       atualizado_em = now()
     WHERE id = $3`,
    [sugestao.classificacao || null, typeof sugestao.urgente === 'boolean' ? sugestao.urgente : null, atendimentoId]
  );
}

// Registra a decisão do usuário (aprovar / editar / recusar) — NUNCA envia
// nada ao marketplace (ver cabeçalho do arquivo). `respostaFinal` é
// obrigatória em 'aprovada'/'editada' (o texto que o usuário decidiu, igual
// à sugestão quando aprovada sem mudar nada); em 'recusada' pode ser nula.
async function registrarDecisao(respostaId, { statusDecisao, respostaFinal, decididoPor }) {
  const { rows } = await pool.query(
    `UPDATE sac_respostas
        SET status_decisao = $1, resposta_final = $2, decidido_em = now(), decidido_por = $3, atualizado_em = now()
      WHERE id = $4 AND status_decisao = 'pendente'
      RETURNING *`,
    [statusDecisao, respostaFinal || null, decididoPor || null, respostaId]
  );
  if (!rows.length) return null;

  const novoStatusAtendimento = statusDecisao === 'recusada' ? 'aguardando_resposta' : 'respondido';
  await pool.query(
    `UPDATE sac_atendimentos SET status = $1, atualizado_em = now()
       FROM sac_respostas WHERE sac_respostas.id = $2 AND sac_atendimentos.id = sac_respostas.atendimento_id`,
    [novoStatusAtendimento, respostaId]
  );
  return rows[0];
}

// Marca manualmente um atendimento como resolvido (ex.: o usuário já
// resolveu por fora do Cerne) — nunca automático, sempre uma ação explícita
// do usuário na tela.
async function marcarResolvido(atendimentoId, empresaId) {
  const { rows } = await pool.query(
    `UPDATE sac_atendimentos SET status = 'resolvido', atualizado_em = now()
      WHERE id = $1 AND empresa_id = $2 RETURNING id`,
    [atendimentoId, empresaId]
  );
  return rows.length > 0;
}

function linhaAtendimentoParaApi(row) {
  return {
    id: row.id,
    marketplace: row.marketplace,
    contaId: row.conta_id,
    tipoOrigem: row.tipo_origem,
    idExterno: row.id_externo,
    pedidoRef: row.pedido_ref,
    sku: row.sku,
    produtoTitulo: row.produto_titulo,
    clienteNome: row.cliente_nome,
    clienteIdExterno: row.cliente_id_externo,
    mensagemCliente: row.mensagem_cliente,
    dataRecebido: row.data_recebido,
    status: row.status,
    classificacao: row.classificacao,
    urgente: row.urgente,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    loja: row.loja || null,
    respostaPendente: row.resposta_pendente_id
      ? {
          id: row.resposta_pendente_id,
          respostaSugeridaIa: row.resposta_sugerida_ia,
          motivoSemSugestao: row.motivo_sem_sugestao,
        }
      : null,
    ultimaDecisao: row.decisao_status
      ? {
          statusDecisao: row.decisao_status,
          respostaFinal: row.decisao_resposta_final,
          decididoEm: row.decisao_decidido_em,
          decididoPor: row.decisao_decidido_por,
        }
      : null,
  };
}

// Lista atendimentos pra caixa de entrada unificada, com a sugestão
// pendente (quando houver) e a última decisão já tomada juntadas na mesma
// linha — evita N+1 (uma query só, com LATERAL). Filtros: marketplace,
// tipoOrigem, status, urgente, busca (cliente/produto/sku/mensagem).
async function listarAtendimentos(empresaId, filtros = {}) {
  const params = [empresaId];
  const condicoes = ['a.empresa_id = $1'];

  if (filtros.marketplace) { params.push(filtros.marketplace); condicoes.push(`a.marketplace = $${params.length}`); }
  if (filtros.tipoOrigem) { params.push(filtros.tipoOrigem); condicoes.push(`a.tipo_origem = $${params.length}`); }
  if (filtros.status) { params.push(filtros.status); condicoes.push(`a.status = $${params.length}`); }
  if (filtros.urgente === true) { condicoes.push('a.urgente = TRUE'); }
  if (filtros.busca) {
    params.push(`%${filtros.busca}%`);
    condicoes.push(`(a.cliente_nome ILIKE $${params.length} OR a.produto_titulo ILIKE $${params.length} OR a.sku ILIKE $${params.length} OR a.mensagem_cliente ILIKE $${params.length})`);
  }

  const limite = Math.min(Number(filtros.limit) || 200, 500);

  const { rows } = await pool.query(
    `SELECT a.*,
            rp.id AS resposta_pendente_id, rp.resposta_sugerida_ia, rp.motivo_sem_sugestao,
            ud.status_decisao AS decisao_status, ud.resposta_final AS decisao_resposta_final,
            ud.decidido_em AS decisao_decidido_em, ud.decidido_por AS decisao_decidido_por
       FROM sac_atendimentos a
       LEFT JOIN LATERAL (
         SELECT * FROM sac_respostas WHERE atendimento_id = a.id AND status_decisao = 'pendente' LIMIT 1
       ) rp ON TRUE
       LEFT JOIN LATERAL (
         SELECT * FROM sac_respostas WHERE atendimento_id = a.id AND status_decisao <> 'pendente'
          ORDER BY decidido_em DESC LIMIT 1
       ) ud ON TRUE
      WHERE ${condicoes.join(' AND ')}
      ORDER BY a.urgente DESC, (a.status IN ('novo','aguardando_resposta')) DESC, a.data_recebido DESC
      LIMIT ${limite}`,
    params
  );
  return rows.map(linhaAtendimentoParaApi);
}

async function buscarAtendimento(id, empresaId) {
  const { rows } = await pool.query(
    `SELECT a.*,
            rp.id AS resposta_pendente_id, rp.resposta_sugerida_ia, rp.motivo_sem_sugestao,
            ud.status_decisao AS decisao_status, ud.resposta_final AS decisao_resposta_final,
            ud.decidido_em AS decisao_decidido_em, ud.decidido_por AS decisao_decidido_por
       FROM sac_atendimentos a
       LEFT JOIN LATERAL (
         SELECT * FROM sac_respostas WHERE atendimento_id = a.id AND status_decisao = 'pendente' LIMIT 1
       ) rp ON TRUE
       LEFT JOIN LATERAL (
         SELECT * FROM sac_respostas WHERE atendimento_id = a.id AND status_decisao <> 'pendente'
          ORDER BY decidido_em DESC LIMIT 1
       ) ud ON TRUE
      WHERE a.id = $1 AND a.empresa_id = $2`,
    [id, empresaId]
  );
  if (!rows.length) return null;
  const atendimento = linhaAtendimentoParaApi(rows[0]);

  const { rows: historico } = await pool.query(
    `SELECT * FROM sac_respostas WHERE atendimento_id = $1 ORDER BY criado_em DESC`,
    [id]
  );
  atendimento.historicoRespostas = historico.map((r) => ({
    id: r.id,
    respostaSugeridaIa: r.resposta_sugerida_ia,
    motivoSemSugestao: r.motivo_sem_sugestao,
    respostaFinal: r.resposta_final,
    statusDecisao: r.status_decisao,
    decididoEm: r.decidido_em,
    decididoPor: r.decidido_por,
    criadoEm: r.criado_em,
  }));
  return atendimento;
}

// Resposta ainda pendente de decisão, pra registrarDecisao conferir que ela
// pertence mesmo à empresa antes de decidir (nunca decide uma resposta de
// outra empresa por engano).
async function buscarRespostaPendenteDaEmpresa(respostaId, empresaId) {
  const { rows } = await pool.query(
    `SELECT r.* FROM sac_respostas r
       JOIN sac_atendimentos a ON a.id = r.atendimento_id
      WHERE r.id = $1 AND a.empresa_id = $2 AND r.status_decisao = 'pendente'`,
    [respostaId, empresaId]
  );
  return rows[0] || null;
}

// Estatísticas por marketplace pra tela do agente (KPIs pedidos no spec:
// atendimentos novos, aguardando resposta, respondidos hoje, reclamações
// abertas, devoluções abertas, tempo médio de resposta, críticos).
async function estatisticasAgente(empresaId, marketplace) {
  assertMarketplace(marketplace);
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'novo')                                             AS novos,
       count(*) FILTER (WHERE status = 'aguardando_resposta')                               AS aguardando_resposta,
       count(*) FILTER (WHERE status = 'respondido' AND atualizado_em::date = CURRENT_DATE) AS respondidos_hoje,
       count(*) FILTER (WHERE tipo_origem = 'reclamacao' AND status NOT IN ('respondido','resolvido')) AS reclamacoes_abertas,
       count(*) FILTER (WHERE tipo_origem = 'devolucao' AND status NOT IN ('respondido','resolvido'))  AS devolucoes_abertas,
       count(*) FILTER (WHERE urgente = TRUE AND status NOT IN ('respondido','resolvido'))  AS criticos,
       count(*) FILTER (WHERE criado_em::date = CURRENT_DATE)                               AS novos_hoje,
       max(atualizado_em)                                                                    AS ultima_atualizacao
     FROM sac_atendimentos WHERE empresa_id = $1 AND marketplace = $2`,
    [empresaId, marketplace]
  );
  const r = rows[0] || {};

  const { rows: tempoRows } = await pool.query(
    `SELECT avg(EXTRACT(EPOCH FROM (r.decidido_em - a.criado_em)) / 60) AS minutos
       FROM sac_respostas r JOIN sac_atendimentos a ON a.id = r.atendimento_id
      WHERE a.empresa_id = $1 AND a.marketplace = $2
        AND r.status_decisao IN ('aprovada','editada') AND r.decidido_em::date = CURRENT_DATE`,
    [empresaId, marketplace]
  );
  const tempoMedioRespostaMin = tempoRows[0] && tempoRows[0].minutos !== null ? Math.round(Number(tempoRows[0].minutos)) : null;

  return {
    atendimentosNovos: Number(r.novos || 0),
    aguardandoResposta: Number(r.aguardando_resposta || 0),
    respondidosHoje: Number(r.respondidos_hoje || 0),
    reclamacoesAbertas: Number(r.reclamacoes_abertas || 0),
    devolucoesAbertas: Number(r.devolucoes_abertas || 0),
    atendimentosCriticos: Number(r.criticos || 0),
    tempoMedioRespostaMin,
    // pra lib/ia/agentesResumo.js reaproveitar (mesmo formato de
    // statsAgentesDecisoes em ads/promoções, ver comentário lá).
    pendentes: Number(r.aguardando_resposta || 0),
    decididasHoje: Number(r.respondidos_hoje || 0),
    sugestoesNovasHoje: Number(r.novos_hoje || 0),
    ultimaAtualizacao: r.ultima_atualizacao || null,
  };
}

module.exports = {
  MARKETPLACES,
  AGENTE_POR_MARKETPLACE,
  upsertAtendimento,
  upsertSugestaoPendente,
  registrarDecisao,
  marcarResolvido,
  listarAtendimentos,
  buscarAtendimento,
  buscarRespostaPendenteDaEmpresa,
  estatisticasAgente,
};
