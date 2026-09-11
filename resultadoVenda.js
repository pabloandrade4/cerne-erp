// Cálculo do resultado financeiro de uma venda, compartilhado entre a listagem
// e o detalhe de pedidos (routes/pedidos.js) — para nunca ter duas fórmulas
// divergentes do mesmo cálculo.
//
// Regra do usuário: nunca inventar valor. Se qualquer parte estiver faltando
// (tarifa que o Mercado Livre não retornou, frete do vendedor ausente, custo
// do produto ainda não cadastrado), o resultado final fica null — nunca um
// número calculado com uma parte assumida como zero.
//
// Correção de 24/08/2026 (reconciliação PF ERP x Mercado Turbo — ver
// docs/04-alteracoes.md): `desconto` é o valor real que reduz a receita da
// venda mas não aparece em `valorVenda` (order.total_amount) — hoje, só o
// cupom pago pelo comprador/Mercado Livre em cima do pagamento
// (payments[].coupon_amount, somado em lib/relatorioVendas.js a partir dos
// pagamentos aprovados do pedido). Diferente das tarifas/frete/custo, a
// ausência de cupom é um FATO real (não dado faltando) — por isso `desconto`
// sempre chega aqui como número (0 quando não há cupom), nunca null, e por
// isso não faz parte de `calculoCompleto`. A base do imposto passou a ser a
// receita já líquida desse desconto (valorVendaLiquido), não mais o valor
// bruto do pedido.
function round2(n) {
  return Math.round(n * 100) / 100;
}

function calcularResultadoVenda({
  valorVenda,
  taxaVenda,
  pagamentoTaxas,
  pagamentoTaxaMarketplace,
  freteVendedor,
  custoProduto,
  aliquotaImposto,
  desconto,
}) {
  const descontoTotal = desconto || 0;
  const valorVendaLiquido = valorVenda !== null ? round2(valorVenda - descontoTotal) : null;

  const tarifasComponentes = [
    { label: 'Comissão da venda (sale_fee)', valor: taxaVenda },
    { label: 'Taxas do pagamento', valor: pagamentoTaxas },
    { label: 'Tarifa de marketplace do pagamento', valor: pagamentoTaxaMarketplace },
  ];
  const tarifasDisponiveis = tarifasComponentes.filter((c) => c.valor !== null);
  const tarifasTotal = tarifasDisponiveis.length
    ? round2(tarifasDisponiveis.reduce((s, c) => s + c.valor, 0))
    : null;

  const imposto = valorVendaLiquido !== null ? round2(valorVendaLiquido * ((aliquotaImposto || 0) / 100)) : null;

  const calculoCompleto =
    valorVenda !== null &&
    tarifasTotal !== null &&
    freteVendedor !== null &&
    imposto !== null &&
    custoProduto !== null;

  const resultado = calculoCompleto
    ? round2(valorVendaLiquido - tarifasTotal - freteVendedor - imposto - custoProduto)
    : null;

  return { tarifasComponentes, tarifasTotal, imposto, resultado, calculoCompleto, desconto: descontoTotal, valorVendaLiquido };
}

module.exports = { calcularResultadoVenda, round2 };
