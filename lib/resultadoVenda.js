// Cálculo do resultado financeiro de uma venda, compartilhado entre a listagem
// e o detalhe de pedidos (routes/pedidos.js) — para nunca ter duas fórmulas
// divergentes do mesmo cálculo.
//
// Regra do usuário: nunca inventar valor. Se qualquer parte estiver faltando
// (tarifa que o Mercado Livre não retornou, frete do vendedor ausente, custo
// do produto ainda não cadastrado), o resultado final fica null — nunca um
// número calculado com uma parte assumida como zero.
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
}) {
  const tarifasComponentes = [
    { label: 'Comissão da venda (sale_fee)', valor: taxaVenda },
    { label: 'Taxas do pagamento', valor: pagamentoTaxas },
    { label: 'Tarifa de marketplace do pagamento', valor: pagamentoTaxaMarketplace },
  ];
  const tarifasDisponiveis = tarifasComponentes.filter((c) => c.valor !== null);
  const tarifasTotal = tarifasDisponiveis.length
    ? round2(tarifasDisponiveis.reduce((s, c) => s + c.valor, 0))
    : null;

  const imposto = valorVenda !== null ? round2(valorVenda * ((aliquotaImposto || 0) / 100)) : null;

  const calculoCompleto =
    valorVenda !== null &&
    tarifasTotal !== null &&
    freteVendedor !== null &&
    imposto !== null &&
    custoProduto !== null;

  const resultado = calculoCompleto
    ? round2(valorVenda - tarifasTotal - freteVendedor - imposto - custoProduto)
    : null;

  return { tarifasComponentes, tarifasTotal, imposto, resultado, calculoCompleto };
}

module.exports = { calcularResultadoVenda, round2 };
