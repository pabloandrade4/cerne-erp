// Fonte única dos números de vendas usados em Visão Geral, Pedidos e
// Financeiro — as três telas chamam estas mesmas funções, com a mesma regra
// de cálculo (lib/resultadoVenda.js), pro mesmo período nunca aparecer com
// valores diferentes em telas diferentes.
//
// Regra combinada com o usuário: pedido com status "cancelled" no Mercado
// Livre não é venda de verdade — não entra no faturamento, taxas, frete,
// imposto, custo nem margem. Ele é contado à parte, só como "pedidos
// cancelados" (quantidade e valor), pra não ficar escondido nem misturado
// com o resultado financeiro real.
const pool = require('../db/pool');
const { calcularResultadoVenda, round2 } = require('./resultadoVenda');
const { diaBRT } = require('./periodo');

const STATUS_CANCELADO = 'cancelled';

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

function serializarPedido(row, aliquotaImposto) {
  const valorVenda = toNum(row.valor_total);
  const custoProduto = toNum(row.custo_produto_total);
  const calc = calcularResultadoVenda({
    valorVenda,
    taxaVenda: toNum(row.taxa_venda_total),
    pagamentoTaxas: toNum(row.pagamento_taxas),
    pagamentoTaxaMarketplace: toNum(row.pagamento_taxa_marketplace),
    freteVendedor: toNum(row.frete_vendedor),
    custoProduto,
    aliquotaImposto,
  });
  const margemPercentual = calc.resultado !== null && valorVenda
    ? round2((calc.resultado / valorVenda) * 100)
    : null;

  return {
    id: row.id,
    empresaId: row.empresa_id,
    contaMlId: row.conta_ml_id,
    loja: row.conta_nickname,
    mlOrderId: String(row.ml_order_id),
    dataCriacao: row.data_criacao,
    status: row.status,
    cancelado: row.status === STATUS_CANCELADO,
    compradorNickname: row.comprador_nickname,
    valorTotal: valorVenda,
    moeda: row.moeda,
    produtoResumo: row.item_resumo,
    skuResumo: row.sku_resumo,
    qtdItens: Number(row.qtd_itens) || 0,
    qtdUnidades: Number(row.qtd_unidades) || 0,
    freteComprador: toNum(row.frete_comprador),
    freteVendedor: toNum(row.frete_vendedor),
    envioLogisticType: row.envio_logistic_type,
    tarifasMl: calc.tarifasTotal,
    imposto: calc.imposto,
    custoProduto,
    margemContribuicao: calc.resultado,
    margemPercentual,
    calculoCompleto: calc.calculoCompleto,
  };
}

// Busca os pedidos de uma empresa dentro do período [desde, ate), já com o
// resultado financeiro calculado (mesma fórmula do detalhe do pedido).
async function buscarPedidosDoPeriodo({ empresaId, desde, ate, limit }) {
  const { rows: configRows } = await pool.query(
    'SELECT aliquota_imposto FROM config_financeiro WHERE empresa_id = $1',
    [empresaId]
  );
  const aliquotaImposto = configRows.length ? Number(configRows[0].aliquota_imposto) : 0;

  const { rows: totalRows } = await pool.query(
    `SELECT count(*) FROM ml_pedidos p
     JOIN ml_contas c ON c.id = p.conta_ml_id
     WHERE c.empresa_id = $1 AND p.data_criacao >= $2 AND p.data_criacao < $3`,
    [empresaId, desde, ate]
  );
  const totalNoPeriodo = Number(totalRows[0].count);

  const { rows } = await pool.query(
    `SELECT p.*, c.nickname AS conta_nickname,
            (SELECT string_agg(titulo, ' + ' ORDER BY id) FROM (
               SELECT titulo, id FROM ml_pedido_itens WHERE pedido_id = p.id ORDER BY id LIMIT 3
             ) t) AS item_resumo,
            (SELECT string_agg(DISTINCT sku, ', ') FROM ml_pedido_itens WHERE pedido_id = p.id AND sku IS NOT NULL) AS sku_resumo,
            (SELECT count(*) FROM ml_pedido_itens WHERE pedido_id = p.id) AS qtd_itens,
            (SELECT COALESCE(SUM(quantidade), 0) FROM ml_pedido_itens WHERE pedido_id = p.id) AS qtd_unidades,
            (SELECT CASE WHEN bool_and(cp.custo IS NOT NULL) THEN SUM(cp.custo * pi.quantidade) ELSE NULL END
               FROM ml_pedido_itens pi
               LEFT JOIN custos_produto cp ON cp.empresa_id = $1 AND cp.sku = pi.sku
               WHERE pi.pedido_id = p.id
            ) AS custo_produto_total
     FROM ml_pedidos p
     JOIN ml_contas c ON c.id = p.conta_ml_id
     WHERE c.empresa_id = $1 AND p.data_criacao >= $2 AND p.data_criacao < $3
     ORDER BY p.data_criacao DESC NULLS LAST
     ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [empresaId, desde, ate]
  );

  return {
    pedidos: rows.map((r) => serializarPedido(r, aliquotaImposto)),
    aliquotaImposto,
    totalNoPeriodo,
  };
}

function somarComPendencia(pedidos, campo) {
  let soma = 0;
  let temValor = false;
  let pendentes = 0;
  for (const p of pedidos) {
    if (p[campo] === null) pendentes++;
    else {
      soma += p[campo];
      temValor = true;
    }
  }
  return { valor: temValor ? round2(soma) : null, pendentes };
}

// Resume um conjunto de pedidos (já filtrado pro período) nos totais usados
// por Visão Geral e Financeiro. Pedidos cancelados ficam de fora de todo
// esse resumo — eles aparecem só em `cancelados`.
function resumirPeriodo(pedidosComCancelados) {
  const cancelados = pedidosComCancelados.filter((p) => p.cancelado);
  const pedidos = pedidosComCancelados.filter((p) => !p.cancelado);

  const qtdPedidos = pedidos.length;
  const faturamento = somarComPendencia(pedidos, 'valorTotal');
  const tarifas = somarComPendencia(pedidos, 'tarifasMl');
  const freteVendedor = somarComPendencia(pedidos, 'freteVendedor');
  const imposto = somarComPendencia(pedidos, 'imposto');
  const custoProduto = somarComPendencia(pedidos, 'custoProduto');

  const completos = pedidos.filter((p) => p.calculoCompleto);
  const margemContribuicao = {
    valor: completos.length ? round2(completos.reduce((s, p) => s + p.margemContribuicao, 0)) : null,
    pendentes: qtdPedidos - completos.length,
  };
  const margemPercentual = margemContribuicao.valor !== null && faturamento.valor
    ? round2((margemContribuicao.valor / faturamento.valor) * 100)
    : null;

  const cancelamentoValor = somarComPendencia(cancelados, 'valorTotal');

  return {
    qtdPedidos,
    faturamento,
    tarifas,
    freteVendedor,
    imposto,
    custoProduto,
    margemContribuicao,
    margemPercentual,
    cancelados: { quantidade: cancelados.length, valor: cancelamentoValor.valor },
  };
}

// Série diária (faturamento e margem de contribuição por dia, em horário de
// Brasília) pro gráfico de Visão Geral. Pedidos cancelados ficam de fora,
// mesma regra do resumo. Dias com algum pedido sem custo de SKU cadastrado
// somam só a margem que já é conhecida (nunca inventa o que falta).
function serieDiaria(pedidosComCancelados) {
  const pedidos = pedidosComCancelados.filter((p) => !p.cancelado);
  const porDia = new Map();
  for (const p of pedidos) {
    if (!p.dataCriacao) continue;
    const dia = diaBRT(p.dataCriacao);
    if (!porDia.has(dia)) porDia.set(dia, { dia, faturamento: 0, margemContribuicao: 0 });
    const acc = porDia.get(dia);
    if (p.valorTotal !== null) acc.faturamento += p.valorTotal;
    if (p.calculoCompleto) acc.margemContribuicao += p.margemContribuicao;
  }
  return [...porDia.values()]
    .sort((a, b) => (a.dia < b.dia ? -1 : 1))
    .map((d) => ({ dia: d.dia, faturamento: round2(d.faturamento), margemContribuicao: round2(d.margemContribuicao) }));
}

module.exports = { buscarPedidosDoPeriodo, resumirPeriodo, serieDiaria, STATUS_CANCELADO };
