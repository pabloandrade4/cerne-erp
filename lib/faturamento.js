// Faturamento — ativado em 24/08/2026. Central dos pedidos que precisam
// ser faturados: NÃO duplica pedido nenhum — reaproveita
// buscarPedidosDoPeriodo (lib/relatorioVendas.js, a mesma fonte única já
// usada por Visão Geral/Pedidos/Financeiro/DRE) para a lista de pedidos, e
// só acrescenta a situação de faturamento de cada um (tabela
// faturamento_pedidos, 1 pedido = no máximo 1 linha).
//
// Um pedido sem linha em faturamento_pedidos ainda é, por padrão,
// "aguardando_faturamento" — a tabela só ganha uma linha quando o usuário
// muda esse status pela primeira vez (evita ter que pré-criar uma linha
// para cada pedido sincronizado).
//
// Nesta etapa NÃO existe emissão real de NF-e (SEFAZ) — só o
// acompanhamento manual da situação, preparando o fluxo (seleção múltipla,
// filtros) para quando a emissão fiscal for ligada de verdade.
const pool = require('../db/pool');
const { buscarPedidosDoPeriodo } = require('./relatorioVendas');

const STATUS_VALIDOS = ['aguardando_faturamento', 'faturado', 'erro', 'cancelado'];
// LEGADO — mantido só porque outro módulo pode importar este nome; não é
// mais usado dentro deste arquivo desde 22/09/2026 (ver MARKETPLACE_LABEL
// abaixo, que substitui o rótulo fixo por um por canal de verdade, agora
// que existem 3).
const MARKETPLACE_UNICO = 'Mercado Livre';
const MARKETPLACE_LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', balcao: 'Venda no balcão' };

// CORREÇÃO (22/09/2026, feature "Venda de Balcão" — ver db/schema.sql):
// `empresaDoPedido` consultava SÓ `ml_pedidos` por id — bug pré-existente
// pra Shopee (id podia colidir com um pedido do Mercado Livre; na melhor
// das hipóteses dava 404, na pior confirmava a situação de um pedido ERRADO
// que só por coincidência tinha o mesmo id) e ia se repetir pra Balcão.
// Agora recebe o `marketplace` (vindo do `detailKey` composto — ver
// atualizarSituacao abaixo) e consulta a tabela certa, sempre sem
// ambiguidade.
async function empresaDoPedido(pedidoId, marketplace) {
  if (marketplace === 'shopee') {
    const { rows } = await pool.query(
      `SELECT c.empresa_id FROM shopee_pedidos p JOIN shopee_contas c ON c.id = p.conta_shopee_id WHERE p.id = $1`,
      [pedidoId]
    );
    return rows.length ? rows[0].empresa_id : null;
  }
  if (marketplace === 'balcao') {
    const { rows } = await pool.query(`SELECT empresa_id FROM vendas_balcao WHERE id = $1`, [pedidoId]);
    return rows.length ? rows[0].empresa_id : null;
  }
  const { rows } = await pool.query(
    `SELECT c.empresa_id FROM ml_pedidos p JOIN ml_contas c ON c.id = p.conta_ml_id WHERE p.id = $1`,
    [pedidoId]
  );
  return rows.length ? rows[0].empresa_id : null;
}

// Separa um `detailKey` ("mercado_livre:123"/"shopee:57"/"balcao:9" — ver
// lib/relatorioVendas.js#serializarPedido) em marketplace + id bruto. Um
// valor sem ":" nunca deveria acontecer nesta tela (a listagem sempre
// devolve detailKey composto desde que este arquivo existe), mas cai em
// Mercado Livre por segurança, nunca quebra com uma exceção.
function separarDetailKey(detailKey) {
  const chave = String(detailKey || '');
  const pos = chave.indexOf(':');
  if (pos === -1) return { marketplace: 'mercado_livre', pedidoId: chave };
  return { marketplace: chave.slice(0, pos), pedidoId: chave.slice(pos + 1) };
}

// Lista os pedidos do período (empresa + período do header) com a situação
// de faturamento de cada um. `status` filtra pela situação de faturamento
// (não pelo status do pedido no Mercado Livre); `search` procura por
// número do pedido, loja ou cliente.
async function listarFaturamento({ empresaId, desde, ate, status, search }) {
  const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });

  // CORREÇÃO (22/09/2026): a chave de busca em faturamento_pedidos agora é
  // composta (pedido_id + marketplace — ver db/schema.sql), porque o mesmo
  // pedido_id numérico pode existir em Mercado Livre, Shopee e Balcão ao
  // mesmo tempo (sequências SERIAL independentes por tabela). A busca usa
  // `p.detailKey` ("marketplace:id" — ver lib/relatorioVendas.js) como
  // chave do mapa, nunca o id sozinho.
  const ids = pedidos.map((p) => p.id);
  let situacoesPorPedido = {};
  if (ids.length) {
    const { rows } = await pool.query(
      'SELECT pedido_id, marketplace, status, observacao FROM faturamento_pedidos WHERE pedido_id = ANY($1::int[])',
      [ids]
    );
    situacoesPorPedido = Object.fromEntries(rows.map((r) => [`${r.marketplace}:${r.pedido_id}`, r]));
  }

  let itens = pedidos.map((p) => {
    const sit = situacoesPorPedido[p.detailKey];
    return {
      pedidoId: p.id,
      detailKey: p.detailKey,
      mlOrderId: p.mlOrderId,
      data: p.dataEfetiva || p.dataCriacao,
      marketplace: MARKETPLACE_LABEL[p.marketplace] || p.marketplace,
      loja: p.loja,
      cliente: p.compradorNickname,
      valor: p.valorTotal,
      statusPedido: p.status,
      pedidoCancelado: p.cancelado,
      situacaoFaturamento: sit ? sit.status : 'aguardando_faturamento',
      observacao: sit ? sit.observacao : null,
    };
  });

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    itens = itens.filter((i) =>
      String(i.mlOrderId).includes(q) ||
      (i.cliente || '').toLowerCase().includes(q) ||
      (i.loja || '').toLowerCase().includes(q)
    );
  }
  if (status) itens = itens.filter((i) => i.situacaoFaturamento === status);

  return { itens, totalNoPeriodo };
}

// Muda a situação de faturamento de UM pedido (upsert — cria a linha se
// ainda não existir, atualiza se já existir).
//
// CORREÇÃO (22/09/2026): recebe agora o `detailKey` composto
// ("marketplace:id" — ver lib/relatorioVendas.js#serializarPedido), não
// mais o id numérico sozinho, porque esse id pode colidir entre Mercado
// Livre/Shopee/Balcão (sequências SERIAL independentes por tabela).
async function atualizarSituacao(detailKey, { status, observacao }) {
  if (!STATUS_VALIDOS.includes(status)) return { errors: { status: 'Situação de faturamento inválida.' } };

  const { marketplace, pedidoId } = separarDetailKey(detailKey);
  const empresaId = await empresaDoPedido(pedidoId, marketplace);
  if (empresaId === null) return { notFound: true };

  const { rows } = await pool.query(
    `INSERT INTO faturamento_pedidos (pedido_id, empresa_id, marketplace, status, observacao)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (pedido_id, marketplace) DO UPDATE SET status = $4, observacao = $5, updated_at = now()
     RETURNING *`,
    [pedidoId, empresaId, marketplace, status, observacao || null]
  );
  return { situacao: rows[0] };
}

// Muda a situação de faturamento de VÁRIOS pedidos de uma vez (ação em
// lote, a partir da seleção múltipla da tela). Cada pedido é validado
// individualmente (mesma regra de atualizarSituacao) — um pedido
// inexistente não impede os outros de serem atualizados, só entra na lista
// de erros do resultado. Recebe `detailKeys` (array de "marketplace:id"),
// não mais ids numéricos soltos — mesmo motivo do atualizarSituacao acima.
async function atualizarSituacaoEmLote(detailKeys, status) {
  if (!STATUS_VALIDOS.includes(status)) return { errors: { status: 'Situação de faturamento inválida.' } };
  if (!Array.isArray(detailKeys) || !detailKeys.length) return { errors: { detailKeys: 'Selecione ao menos um pedido.' } };

  const atualizados = [];
  const falharam = [];
  for (const key of detailKeys) {
    const result = await atualizarSituacao(key, { status });
    if (result.notFound || result.errors) falharam.push(key);
    else atualizados.push(key);
  }
  return { atualizados, falharam };
}

module.exports = {
  STATUS_VALIDOS,
  MARKETPLACE_UNICO,
  MARKETPLACE_LABEL,
  listarFaturamento,
  atualizarSituacao,
  atualizarSituacaoEmLote,
  empresaDoPedido,
  separarDetailKey,
};
