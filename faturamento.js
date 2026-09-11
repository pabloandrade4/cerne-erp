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
const MARKETPLACE_UNICO = 'Mercado Livre'; // único marketplace integrado hoje — ver docs/01-regras-de-negocio.md

async function empresaDoPedido(pedidoId) {
  const { rows } = await pool.query(
    `SELECT c.empresa_id FROM ml_pedidos p JOIN ml_contas c ON c.id = p.conta_ml_id WHERE p.id = $1`,
    [pedidoId]
  );
  return rows.length ? rows[0].empresa_id : null;
}

// Lista os pedidos do período (empresa + período do header) com a situação
// de faturamento de cada um. `status` filtra pela situação de faturamento
// (não pelo status do pedido no Mercado Livre); `search` procura por
// número do pedido, loja ou cliente.
async function listarFaturamento({ empresaId, desde, ate, status, search }) {
  const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });

  const ids = pedidos.map((p) => p.id);
  let situacoesPorPedido = {};
  if (ids.length) {
    const { rows } = await pool.query(
      'SELECT pedido_id, status, observacao FROM faturamento_pedidos WHERE pedido_id = ANY($1::int[])',
      [ids]
    );
    situacoesPorPedido = Object.fromEntries(rows.map((r) => [r.pedido_id, r]));
  }

  let itens = pedidos.map((p) => {
    const sit = situacoesPorPedido[p.id];
    return {
      pedidoId: p.id,
      mlOrderId: p.mlOrderId,
      data: p.dataEfetiva || p.dataCriacao,
      marketplace: MARKETPLACE_UNICO,
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
async function atualizarSituacao(pedidoId, { status, observacao }) {
  if (!STATUS_VALIDOS.includes(status)) return { errors: { status: 'Situação de faturamento inválida.' } };

  const empresaId = await empresaDoPedido(pedidoId);
  if (empresaId === null) return { notFound: true };

  const { rows } = await pool.query(
    `INSERT INTO faturamento_pedidos (pedido_id, empresa_id, status, observacao)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pedido_id) DO UPDATE SET status = $3, observacao = $4, updated_at = now()
     RETURNING *`,
    [pedidoId, empresaId, status, observacao || null]
  );
  return { situacao: rows[0] };
}

// Muda a situação de faturamento de VÁRIOS pedidos de uma vez (ação em
// lote, a partir da seleção múltipla da tela). Cada pedido é validado
// individualmente (mesma regra de atualizarSituacao) — um pedido
// inexistente não impede os outros de serem atualizados, só entra na lista
// de erros do resultado.
async function atualizarSituacaoEmLote(pedidoIds, status) {
  if (!STATUS_VALIDOS.includes(status)) return { errors: { status: 'Situação de faturamento inválida.' } };
  if (!Array.isArray(pedidoIds) || !pedidoIds.length) return { errors: { pedidoIds: 'Selecione ao menos um pedido.' } };

  const atualizados = [];
  const falharam = [];
  for (const id of pedidoIds) {
    const result = await atualizarSituacao(id, { status });
    if (result.notFound || result.errors) falharam.push(id);
    else atualizados.push(id);
  }
  return { atualizados, falharam };
}

module.exports = {
  STATUS_VALIDOS,
  MARKETPLACE_UNICO,
  listarFaturamento,
  atualizarSituacao,
  atualizarSituacaoEmLote,
  empresaDoPedido,
};
