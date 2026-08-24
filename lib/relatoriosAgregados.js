// Relatórios (categorias Vendas e Margem / Produtos / Marketplaces-Lojas) —
// ativado em 25/08/2026. Regra central do usuário: "os números dos
// Relatórios devem usar as MESMAS regras já utilizadas em Visão Geral,
// Pedidos e Financeiro — não crie cálculos separados". Por isso este
// arquivo NÃO recalcula nada: só reaproveita lib/relatorioVendas.js
// (buscarPedidosDoPeriodo, resumirPeriodo, buscarItensDoPeriodo) e
// lib/ads.js (mesma fonte da tela Ads), filtrando/agrupando os dados já
// calculados por elas — nenhuma fórmula financeira nova.
const { buscarPedidosDoPeriodo, resumirPeriodo, buscarItensDoPeriodo } = require('./relatorioVendas');
const { listarAds } = require('./ads');
const { round2 } = require('./resultadoVenda');

function filtrarPorLoja(pedidos, contaId) {
  if (!contaId) return pedidos;
  return pedidos.filter((p) => String(p.contaMlId) === String(contaId));
}

// Soma de Ads (investimento) do período/empresa/loja — mesma fonte da tela
// Ads (lib/ads.js), nunca uma segunda leitura da API. Quando alguma loja
// está com a sincronização de Ads pendente, o total vem marcado como
// pendente (nunca soma como se o investimento dela fosse zero).
async function investimentoAdsDoPeriodo({ empresaId, contaId, desde, ate, desdeStr, ateStr }) {
  try {
    const resultado = await listarAds({ empresaId, contaId, desde, ate, desdeStr, ateStr });
    if (resultado.semConta) return { valor: null, disponivel: false, motivo: 'sem_conta' };
    const contasIndisponiveis = resultado.situacaoPorConta.filter((s) => !s.disponivel);
    const algumaDisponivel = resultado.situacaoPorConta.some((s) => s.disponivel);
    if (!algumaDisponivel) {
      return { valor: null, disponivel: false, motivo: (contasIndisponiveis[0] && contasIndisponiveis[0].motivo) || 'erro_api' };
    }
    const comInvestimento = resultado.linhas.filter((l) => l.investimento !== null);
    const valor = comInvestimento.length ? round2(comInvestimento.reduce((s, l) => s + l.investimento, 0)) : (resultado.linhas.length ? null : 0);
    return { valor, disponivel: true, parcial: contasIndisponiveis.length > 0 };
  } catch (e) {
    return { valor: null, disponivel: false, motivo: 'erro_api' };
  }
}

// Categoria "Vendas e Margem": os mesmos totais já mostrados em Visão
// Geral/Financeiro (resumirPeriodo, sem alteração nenhuma), só com o filtro
// de loja aplicado ANTES de resumir — exatamente como o Relatório de
// Pedidos (routes/pedidos.js) já faz. Ads é a única linha nova, vinda de
// lib/ads.js (mesma fonte da tela Ads).
async function relatorioVendasMargem({ empresaId, contaId, desde, ate, desdeStr, ateStr }) {
  const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });
  const filtrados = filtrarPorLoja(pedidos, contaId);
  const resumo = resumirPeriodo(filtrados);
  const totalUnidades = filtrados.filter((p) => !p.cancelado).reduce((s, p) => s + (p.qtdUnidades || 0), 0);
  const ads = await investimentoAdsDoPeriodo({ empresaId, contaId, desde, ate, desdeStr, ateStr });

  return { totalNoPeriodo, resumo, totalUnidades, ads };
}

// Categoria "Produtos": agrupa por SKU os ITENS de pedido do período
// (lib/relatorioVendas.js → buscarItensDoPeriodo — mesma fórmula de
// margem, só decomposta por item; ver comentário lá sobre o rateio de
// frete/tarifas de pagamento/desconto quando o pedido tem mais de 1 item).
async function relatorioProdutos({ empresaId, contaId, desde, ate, sku }) {
  const { itens } = await buscarItensDoPeriodo({ empresaId, desde, ate });
  let filtrados = contaId ? itens.filter((it) => String(it.contaMlId) === String(contaId)) : itens;
  if (sku) {
    const alvo = sku.trim().toLowerCase();
    filtrados = filtrados.filter((it) => (it.sku || '').toLowerCase().includes(alvo));
  }

  const porSku = new Map();
  filtrados.forEach((it) => {
    const chave = it.sku || '(sem SKU)';
    if (!porSku.has(chave)) {
      porSku.set(chave, { sku: chave, quantidade: 0, faturamento: 0, custo: 0, imposto: 0, margemContribuicao: 0, pendentes: 0, temCusto: true, temImposto: true, rateado: false });
    }
    const acc = porSku.get(chave);
    acc.quantidade += it.quantidade || 0;
    if (it.valorTotalItem !== null) acc.faturamento = round2(acc.faturamento + it.valorTotalItem);
    if (it.custoProduto !== null) acc.custo = round2(acc.custo + it.custoProduto); else acc.temCusto = false;
    if (it.imposto !== null) acc.imposto = round2(acc.imposto + it.imposto); else acc.temImposto = false;
    if (it.calculoCompleto) acc.margemContribuicao = round2(acc.margemContribuicao + it.margemContribuicao);
    else acc.pendentes += 1;
    if (it.rateado) acc.rateado = true;
  });

  const linhas = [...porSku.values()].map((acc) => ({
    sku: acc.sku,
    quantidade: acc.quantidade,
    faturamento: acc.faturamento,
    custo: acc.temCusto ? acc.custo : null,
    imposto: acc.temImposto ? acc.imposto : null,
    margemContribuicao: acc.pendentes === 0 ? acc.margemContribuicao : null,
    pendentes: acc.pendentes,
    rateado: acc.rateado,
  })).sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0));

  return { linhas, totalItens: filtrados.length };
}

// Categoria "Marketplaces / Lojas": agrupa PEDIDOS (não itens) por conta —
// resumirPeriodo aplicado por loja, mesma função de sempre, sem nenhum
// cálculo novo. Cada pedido pertence inteiro a uma loja só, então não há
// rateio nenhum aqui (diferente de Produtos).
async function relatorioMarketplaces({ empresaId, desde, ate }) {
  const { pedidos } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });
  const porConta = new Map();
  pedidos.forEach((p) => {
    const chave = String(p.contaMlId);
    if (!porConta.has(chave)) porConta.set(chave, { contaMlId: p.contaMlId, loja: p.loja, pedidos: [] });
    porConta.get(chave).pedidos.push(p);
  });

  const linhas = [...porConta.values()].map(({ contaMlId, loja, pedidos: pedidosDaLoja }) => {
    const resumo = resumirPeriodo(pedidosDaLoja);
    return { contaMlId, loja, resumo };
  }).sort((a, b) => (b.resumo.faturamento.valor || 0) - (a.resumo.faturamento.valor || 0));

  return { linhas };
}

module.exports = { relatorioVendasMargem, relatorioProdutos, relatorioMarketplaces, investimentoAdsDoPeriodo };
