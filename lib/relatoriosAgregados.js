// Relatórios (categorias Vendas e Margem / Produtos / Marketplaces-Lojas) —
// ativado em 25/08/2026. Regra central do usuário: "os números dos
// Relatórios devem usar as MESMAS regras já utilizadas em Visão Geral,
// Pedidos e Financeiro — não crie cálculos separados". Por isso este
// arquivo NÃO recalcula nada: só reaproveita lib/relatorioVendas.js
// (buscarPedidosDoPeriodo, resumirPeriodo, buscarItensDoPeriodo) e
// lib/ads.js (mesma fonte da tela Ads), filtrando/agrupando os dados já
// calculados por elas — nenhuma fórmula financeira nova.
const pool = require('../db/pool');
const { buscarPedidosDoPeriodo, resumirPeriodo, buscarItensDoPeriodo } = require('./relatorioVendas');
const { listarAds } = require('./ads');
const { round2 } = require('./resultadoVenda');
const { interpretarSku } = require('./skuProdutoBase');

function filtrarPorLoja(pedidos, contaId) {
  if (!contaId) return pedidos;
  return pedidos.filter((p) => String(p.contaMlId) === String(contaId));
}

// Soma de Ads (investimento) do período/empresa/loja — mesma fonte da tela
// Ads (lib/ads.js), nunca uma segunda leitura da API. Quando alguma loja
// está com a sincronização de Ads pendente, o total vem marcado como
// pendente (nunca soma como se o investimento dela fosse zero).
async function investimentoAdsDoPeriodo({ empresaId, contaId, periodoChave, desde, ate, desdeStr, ateStr }) {
  try {
    const resultado = await listarAds({ empresaId, contaId, periodoChave, desde, ate, desdeStr, ateStr });
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
async function relatorioVendasMargem({ empresaId, contaId, periodoChave, desde, ate, desdeStr, ateStr }) {
  const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });
  const filtrados = filtrarPorLoja(pedidos, contaId);
  const resumo = resumirPeriodo(filtrados);
  const totalUnidades = filtrados.filter((p) => !p.cancelado).reduce((s, p) => s + (p.qtdUnidades || 0), 0);
  const ads = await investimentoAdsDoPeriodo({ empresaId, contaId, periodoChave, desde, ate, desdeStr, ateStr });

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

// Resolve, para um conjunto de SKUs de uma empresa, o produto base (medida
// física, ex: 'CX-20X20X20') e o multiplicador (unidades físicas por kit)
// de cada um — FONTE ÚNICA E CENTRALIZADA usada pela visão "Por Caixa" do
// Relatório de Produtos (nunca uma lógica frágil no frontend, nem uma
// segunda regra de conversão). Ordem de prioridade:
//   1) Vínculo SALVO em `produto_base_skus` (estrutura que já existia no
//      banco, criada na etapa de Estoque Produto Base — desativada para
//      Estoque, mas nunca apagada — ver docs/02-decisoes.md). Reaproveitada
//      aqui como pedido pelo usuário ("se já existir alguma estrutura...
//      utilize-a"). Um vínculo salvo é sempre a fonte que vale, porque pode
//      ter sido corrigido manualmente por um humano.
//   2) Sem vínculo salvo: interpreta o próprio texto do SKU pelo padrão que
//      o usuário descreveu (dígitos no início = multiplicador, resto =
//      código do produto base — `lib/skuProdutoBase.js`, a mesma função já
//      usada para sugerir vínculos em GET /api/produtos-base/vinculos/
//      sugestoes). Isto não é uma estimativa financeira — é leitura
//      determinística de um identificador estruturado que o próprio SKU já
//      contém, então é seguro aplicar automaticamente no relatório.
//   3) SKU nulo, vazio, ou que não segue o padrão (não começa com dígitos):
//      NUNCA é chutado. Fica sem produto base identificado — some do
//      agrupamento "Por Caixa" e aparece à parte, de forma transparente
//      (mesmo espírito de "nunca inventar" já usado em custo/imposto
//      pendente no resto do sistema).
async function resolverProdutosBasePorSku(empresaId, skus) {
  const unicos = [...new Set(skus.filter(Boolean))];
  let salvos = {};
  if (unicos.length) {
    const { rows } = await pool.query(
      `SELECT v.sku, v.multiplicador, pb.codigo AS produto_base_codigo
       FROM produto_base_skus v
       JOIN produtos_base pb ON pb.id = v.produto_base_id
       WHERE v.empresa_id = $1 AND v.sku = ANY($2::text[])`,
      [empresaId, unicos]
    );
    salvos = Object.fromEntries(rows.map((r) => [r.sku, { codigoBase: r.produto_base_codigo, multiplicador: r.multiplicador, origem: 'salvo' }]));
  }

  const resolucoes = {};
  for (const sku of unicos) {
    if (salvos[sku]) { resolucoes[sku] = salvos[sku]; continue; }
    const interpretado = interpretarSku(sku);
    resolucoes[sku] = interpretado
      ? { codigoBase: interpretado.codigoBase, multiplicador: interpretado.multiplicador, origem: 'padrao_sku' }
      : null;
  }
  return resolucoes;
}

// Categoria "Produtos", visão "Por Caixa": os MESMOS itens de
// buscarItensDoPeriodo usados por relatorioProdutos (mesmo período, mesma
// loja, mesma fonte — nenhum cálculo financeiro novo), agrupados pelo
// produto base físico em vez do SKU/kit. Quantidade física = kits vendidos
// (quantidade do item) × multiplicador do SKU; faturamento é a SOMA do
// faturamento de TODOS os SKUs/kit daquele produto base — NUNCA dividido
// pela quantidade de caixas (pedido explícito do usuário).
async function relatorioProdutosPorCaixa({ empresaId, contaId, desde, ate }) {
  const { itens } = await buscarItensDoPeriodo({ empresaId, desde, ate });
  const filtrados = contaId ? itens.filter((it) => String(it.contaMlId) === String(contaId)) : itens;

  const resolucoes = await resolverProdutosBasePorSku(empresaId, filtrados.map((it) => it.sku));

  const porCaixa = new Map();
  const semProdutoBase = new Map();

  filtrados.forEach((it) => {
    const resolucao = it.sku ? resolucoes[it.sku] : null;
    const quantidadeKit = it.quantidade || 0;

    if (!resolucao) {
      const chave = it.sku || '(sem SKU)';
      if (!semProdutoBase.has(chave)) semProdutoBase.set(chave, { sku: chave, kitsVendidos: 0, faturamento: 0, pedidos: new Set() });
      const acc = semProdutoBase.get(chave);
      acc.kitsVendidos += quantidadeKit;
      if (it.valorTotalItem !== null) acc.faturamento = round2(acc.faturamento + it.valorTotalItem);
      acc.pedidos.add(it.pedidoId);
      return;
    }

    const chave = resolucao.codigoBase;
    if (!porCaixa.has(chave)) {
      porCaixa.set(chave, { produtoBase: chave, quantidadeCaixas: 0, faturamento: 0, kitsVendidos: 0, pedidos: new Set(), skus: new Map(), origemHeuristica: false });
    }
    const acc = porCaixa.get(chave);
    const quantidadeCaixasItem = quantidadeKit * resolucao.multiplicador;
    acc.quantidadeCaixas += quantidadeCaixasItem;
    acc.kitsVendidos += quantidadeKit;
    if (it.valorTotalItem !== null) acc.faturamento = round2(acc.faturamento + it.valorTotalItem);
    acc.pedidos.add(it.pedidoId);
    if (resolucao.origem === 'padrao_sku') acc.origemHeuristica = true;

    if (!acc.skus.has(it.sku)) {
      acc.skus.set(it.sku, { sku: it.sku, multiplicador: resolucao.multiplicador, origem: resolucao.origem, kitsVendidos: 0, quantidadeCaixas: 0, faturamento: 0 });
    }
    const skuAcc = acc.skus.get(it.sku);
    skuAcc.kitsVendidos += quantidadeKit;
    skuAcc.quantidadeCaixas += quantidadeCaixasItem;
    if (it.valorTotalItem !== null) skuAcc.faturamento = round2(skuAcc.faturamento + it.valorTotalItem);
  });

  const linhas = [...porCaixa.values()].map((acc) => ({
    produtoBase: acc.produtoBase,
    quantidadeCaixas: acc.quantidadeCaixas,
    faturamento: acc.faturamento,
    kitsVendidos: acc.kitsVendidos,
    quantidadePedidos: acc.pedidos.size,
    origemHeuristica: acc.origemHeuristica,
    skus: [...acc.skus.values()].sort((a, b) => b.quantidadeCaixas - a.quantidadeCaixas),
  })).sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0));

  const semProdutoBaseLinhas = [...semProdutoBase.values()].map((acc) => ({
    sku: acc.sku,
    kitsVendidos: acc.kitsVendidos,
    faturamento: acc.faturamento,
    quantidadePedidos: acc.pedidos.size,
  })).sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0));

  return { linhas, semProdutoBase: semProdutoBaseLinhas, totalItens: filtrados.length };
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

module.exports = { relatorioVendasMargem, relatorioProdutos, relatorioProdutosPorCaixa, resolverProdutosBasePorSku, relatorioMarketplaces, investimentoAdsDoPeriodo };
