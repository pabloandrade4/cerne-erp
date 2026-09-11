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

// Bug 4 da reconciliação PF ERP x Mercado Turbo (24/08/2026, ver
// docs/04-alteracoes.md): todo filtro/ordenação de PERÍODO usava só
// data_criacao (order.date_created — quando o pedido foi criado), nunca
// quando ele foi realmente fechado/pago. Um pedido criado num dia mas só
// aprovado/fechado no dia seguinte (ex: 2000018066590190 — 3 tentativas de
// pagamento, criado 22/08, aprovado e fechado só 23/08) ficava sempre no
// período de quando foi CRIADO, mesmo que o Mercado Turbo (e o bom senso
// financeiro) considere a venda como tendo acontecido quando foi
// fechada/paga. data_fechamento (order.date_closed) já era salva pela
// sincronização, só não era usada em nenhum filtro — não precisa de
// migração de schema nem nova sincronização, só passar a usar o dado que já
// existe. Pedidos ainda não fechados (data_fechamento NULL — ex: em
// aberto/pendente) continuam usando data_criacao, sem regressão nenhuma.
const SQL_DATA_EFETIVA = 'COALESCE(p.data_fechamento, p.data_criacao)';

// Bug 3 da reconciliação PF ERP x Mercado Turbo (24/08/2026, ver
// docs/04-alteracoes.md e lib/resultadoVenda.js): soma coupon_amount dos
// pagamentos APROVADOS do pedido — usa a coluna nova (ml_pedido_pagamentos.
// coupon_amount) quando já veio da sincronização, e cai pro raw_pagamento
// (sempre completo, desde o início da integração) pros pagamentos
// sincronizados antes da coluna existir, então nenhum pedido antigo fica
// com o desconto "pendente" por causa disso. COALESCE(...,0) porque não ter
// cupom é 0 de verdade, não dado faltando.
const SQL_DESCONTO_CUPOM = `(
     SELECT COALESCE(SUM(COALESCE(pg.coupon_amount, (pg.raw_pagamento->>'coupon_amount')::numeric)), 0)
     FROM ml_pedido_pagamentos pg
     WHERE pg.pedido_id = p.id AND pg.status = 'approved'
   )`;

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

function serializarPedido(row, aliquotaImposto) {
  const valorVenda = toNum(row.valor_total);
  const custoProduto = toNum(row.custo_produto_total);
  const desconto = toNum(row.desconto_cupom) || 0;
  const calc = calcularResultadoVenda({
    valorVenda,
    taxaVenda: toNum(row.taxa_venda_total),
    pagamentoTaxas: toNum(row.pagamento_taxas),
    pagamentoTaxaMarketplace: toNum(row.pagamento_taxa_marketplace),
    freteVendedor: toNum(row.frete_vendedor),
    custoProduto,
    aliquotaImposto,
    desconto,
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
    dataEfetiva: row.data_efetiva,
    status: row.status,
    cancelado: row.status === STATUS_CANCELADO,
    // Adicionado em 24/08/2026 (tela Recebimentos — ver
    // lib/recebimentosMl.js e docs/04-alteracoes.md): status do primeiro
    // pagamento do pedido (payments[0].status, já salvo desde sempre em
    // ml_pedidos.pagamento_status — nunca usado em nenhum campo serializado
    // até agora). Campo puramente aditivo: não muda nenhum valor já
    // calculado/retornado por esta função, só expõe um dado que já
    // existia no banco.
    pagamentoStatus: row.pagamento_status,
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
    desconto: calc.desconto,
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
     WHERE c.empresa_id = $1 AND ${SQL_DATA_EFETIVA} >= $2 AND ${SQL_DATA_EFETIVA} < $3`,
    [empresaId, desde, ate]
  );
  const totalNoPeriodo = Number(totalRows[0].count);

  const { rows } = await pool.query(
    `SELECT p.*, c.nickname AS conta_nickname,
            ${SQL_DATA_EFETIVA} AS data_efetiva,
            (SELECT string_agg(titulo, ' + ' ORDER BY id) FROM (
               SELECT titulo, id FROM ml_pedido_itens WHERE pedido_id = p.id ORDER BY id LIMIT 3
             ) t) AS item_resumo,
            (SELECT string_agg(DISTINCT sku, ', ') FROM ml_pedido_itens WHERE pedido_id = p.id AND sku IS NOT NULL) AS sku_resumo,
            (SELECT count(*) FROM ml_pedido_itens WHERE pedido_id = p.id) AS qtd_itens,
            (SELECT COALESCE(SUM(quantidade), 0) FROM ml_pedido_itens WHERE pedido_id = p.id) AS qtd_unidades,
            -- Custo do produto vem da tabela produtos (tela Produtos, desde
            -- 24/08/2026 — ver db/schema.sql e docs/02-decisoes.md). Não
            -- filtra por produtos.ativo de propósito: desativar um produto é
            -- só uma flag de catálogo, não apaga o custo histórico usado no
            -- cálculo de vendas já feitas ou futuras desse SKU.
            (SELECT CASE WHEN bool_and(pr.custo IS NOT NULL) THEN SUM(pr.custo * pi.quantidade) ELSE NULL END
               FROM ml_pedido_itens pi
               LEFT JOIN produtos pr ON pr.empresa_id = $1 AND pr.sku = pi.sku
               WHERE pi.pedido_id = p.id
            ) AS custo_produto_total,
            ${SQL_DESCONTO_CUPOM} AS desconto_cupom
     FROM ml_pedidos p
     JOIN ml_contas c ON c.id = p.conta_ml_id
     WHERE c.empresa_id = $1 AND ${SQL_DATA_EFETIVA} >= $2 AND ${SQL_DATA_EFETIVA} < $3
     ORDER BY ${SQL_DATA_EFETIVA} DESC NULLS LAST
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
  const desconto = somarComPendencia(pedidos, 'desconto');
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
    desconto,
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
    // Usa a mesma data efetiva (data_fechamento, com fallback pra
    // data_criacao) usada pro filtro de período (Bug 4 — ver
    // SQL_DATA_EFETIVA acima), senão um pedido que entrou no período pela
    // data de fechamento podia cair fora do gráfico, ou num dia errado.
    if (!p.dataEfetiva) continue;
    const dia = diaBRT(p.dataEfetiva);
    if (!porDia.has(dia)) porDia.set(dia, { dia, faturamento: 0, margemContribuicao: 0 });
    const acc = porDia.get(dia);
    if (p.valorTotal !== null) acc.faturamento += p.valorTotal;
    if (p.calculoCompleto) acc.margemContribuicao += p.margemContribuicao;
  }
  return [...porDia.values()]
    .sort((a, b) => (a.dia < b.dia ? -1 : 1))
    .map((d) => ({ dia: d.dia, faturamento: round2(d.faturamento), margemContribuicao: round2(d.margemContribuicao) }));
}

// Busca os ITENS (linhas de produto/SKU) dos pedidos não cancelados de uma
// empresa no período, com o mesmo cálculo financeiro de
// calcularResultadoVenda (lib/resultadoVenda.js) aplicado por item — nunca
// uma terceira fórmula. Usada por Relatórios (categoria Produtos) e por Ads
// (margem por anúncio), ativados em 25/08/2026 — ver docs/02-decisoes.md.
//
// O Mercado Livre entrega comissão (sale_fee) e custo do produto já
// decompostos por item de verdade: `ml_pedido_itens.taxa_venda` é
// sale_fee×quantidade DAQUELA linha (não do pedido inteiro), e o custo vem
// de `produtos.custo × quantidade` daquela linha — nenhum dos dois é
// rateado, os dois são exatos.
//
// Frete do vendedor, desconto (cupom) e as tarifas de pagamento (além da
// comissão) só existem no nível do PEDIDO — o Mercado Livre não informa
// esses três separados por item. Quando um pedido tem só 1 item, isso não
// importa (100% do pedido pertence a esse item, sem rateio nenhum).
// Quando tem mais de 1 item, essas três partes são RATEADAS
// proporcionalmente ao valor do item dentro do pedido
// (valorTotalItem / valorTotal do pedido) — é um rateio declarado, nunca um
// valor inventado: a soma dos itens de um mesmo pedido sempre volta a bater
// exatamente com o valor real daquele pedido (o mesmo já mostrado em
// Pedidos/DRE/Financeiro).
async function buscarItensDoPeriodo({ empresaId, desde, ate }) {
  const { pedidos, aliquotaImposto } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });
  const pedidosNaoCancelados = pedidos.filter((p) => !p.cancelado);
  if (!pedidosNaoCancelados.length) return { itens: [] };

  const pedidoIds = pedidosNaoCancelados.map((p) => p.id);
  const { rows } = await pool.query(
    `SELECT pi.pedido_id, pi.ml_item_id, pi.sku, pi.titulo, pi.quantidade,
            pi.valor_total_item, pi.taxa_venda,
            pr.custo AS produto_custo
     FROM ml_pedido_itens pi
     LEFT JOIN produtos pr ON pr.empresa_id = $1 AND pr.sku = pi.sku
     WHERE pi.pedido_id = ANY($2::int[])
     ORDER BY pi.pedido_id, pi.id`,
    [empresaId, pedidoIds]
  );

  const pedidosPorId = new Map(pedidosNaoCancelados.map((p) => [p.id, p]));
  const linhasPorPedido = new Map();
  rows.forEach((r) => {
    if (!linhasPorPedido.has(r.pedido_id)) linhasPorPedido.set(r.pedido_id, []);
    linhasPorPedido.get(r.pedido_id).push(r);
  });

  const itens = [];
  for (const [pedidoId, linhas] of linhasPorPedido) {
    const pedido = pedidosPorId.get(pedidoId);
    if (!pedido) continue;

    const multiItem = linhas.length > 1;
    // "Restante" de tarifas fora da comissão por item (taxas/tarifa de
    // marketplace do pagamento) — só existe rateado quando dá pra confiar
    // na soma das comissões por item batendo com a tarifa total do pedido.
    const somaComissaoItens = linhas.reduce((s, l) => {
      const v = toNum(l.taxa_venda);
      return v === null ? s : s + v;
    }, 0);
    const algumaComissaoFaltando = linhas.some((l) => toNum(l.taxa_venda) === null);
    const restanteTarifas = (pedido.tarifasMl !== null && !algumaComissaoFaltando)
      ? round2(pedido.tarifasMl - somaComissaoItens)
      : null;

    linhas.forEach((linha) => {
      const valorItem = toNum(linha.valor_total_item);
      const ratio = (!multiItem)
        ? 1
        : (pedido.valorTotal && valorItem !== null ? valorItem / pedido.valorTotal : null);

      const custoUnitario = toNum(linha.produto_custo);
      const custoProdutoItem = custoUnitario !== null ? round2(custoUnitario * (Number(linha.quantidade) || 0)) : null;

      const comissaoItem = toNum(linha.taxa_venda);
      const pagamentoTaxasItem = (ratio !== null && restanteTarifas !== null) ? round2(restanteTarifas * ratio) : null;
      const freteVendedorItem = (ratio !== null && pedido.freteVendedor !== null) ? round2(pedido.freteVendedor * ratio) : null;
      // Ausência de cupom é 0 de verdade (mesma regra de resultadoVenda.js),
      // então o rateio do desconto nunca fica null — sem ratio confiável
      // (valor do pedido zerado/pendente), fica 0 em vez de indisponível.
      const descontoItem = (ratio !== null) ? round2((pedido.desconto || 0) * ratio) : 0;

      const calc = calcularResultadoVenda({
        valorVenda: valorItem,
        taxaVenda: comissaoItem,
        pagamentoTaxas: pagamentoTaxasItem,
        pagamentoTaxaMarketplace: null,
        freteVendedor: freteVendedorItem,
        custoProduto: custoProdutoItem,
        aliquotaImposto,
        desconto: descontoItem,
      });

      itens.push({
        pedidoId,
        mlOrderId: pedido.mlOrderId,
        dataEfetiva: pedido.dataEfetiva,
        contaMlId: pedido.contaMlId,
        loja: pedido.loja,
        mlItemId: linha.ml_item_id,
        titulo: linha.titulo,
        sku: linha.sku,
        quantidade: Number(linha.quantidade) || 0,
        valorTotalItem: valorItem,
        rateado: multiItem,
        tarifas: calc.tarifasTotal,
        freteVendedor: freteVendedorItem,
        desconto: calc.desconto,
        imposto: calc.imposto,
        custoProduto: custoProdutoItem,
        margemContribuicao: calc.resultado,
        calculoCompleto: calc.calculoCompleto,
      });
    });
  }

  return { itens };
}

module.exports = {
  buscarPedidosDoPeriodo,
  resumirPeriodo,
  serieDiaria,
  buscarItensDoPeriodo,
  STATUS_CANCELADO,
  SQL_DATA_EFETIVA,
  SQL_DESCONTO_CUPOM,
};
