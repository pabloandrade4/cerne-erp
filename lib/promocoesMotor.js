// Motor de cálculo da IA de Promoções (Fase B, 13/09/2026) — pedido explícito
// do usuário: "a IA tem que calcular a margem REAL de cada promoção, nunca
// só o percentual de desconto". Regra de sempre neste projeto: nunca
// fabricar um número — quando falta um dado real (SKU não identificado,
// produto sem custo cadastrado, SKU sem histórico de vendas suficiente para
// estimar comissão/frete), o item fica com `margemIncompleta: true` e um
// `motivoIncompleto` explicando exatamente o que falta, em vez de assumir
// zero ou inventar uma média.
//
// Por que a comissão e o frete do vendedor são ESTIMADOS por histórico (e
// não buscados ao vivo na API do Mercado Livre para cada item promocional):
// a Central de Promoções só devolve preços candidatos/sugeridos por item
// (nunca já vendidos), então não existe "sale_fee" real para esse preço
// ainda. O ERP já calcula comissão e frete real por SKU a partir de vendas
// de verdade (lib/relatorioVendas.js -> lib/resultadoVenda.js, a MESMA fonte
// usada na tela "Margem por Anúncio") — este motor reaproveita exatamente
// esses números (últimos 90 dias), em vez de reinventar uma segunda forma
// de calcular comissão/frete. Isso significa que o valor é uma ESTIMATIVA
// (baseada no histórico real do próprio SKU), nunca um valor "oficial" do
// Mercado Livre para o preço promocional específico — os campos
// `tarifasEstimadas`/`freteVendedorEstimado` deixam isso explícito no nome.
const { calcularResultadoVenda, round2 } = require('./resultadoVenda');

// Amostras mínimas (pedidos recentes) de um SKU para confiarmos na média de
// comissão/frete daquele SKU. Deliberadamente baixo (1) nesta primeira
// versão — exigir mais historico deixaria a maioria dos SKUs sem análise
// nenhuma logo de início. Pode subir no futuro se o usuário preferir mais
// rigor (nunca decidido escondido — ver motivoIncompleto quando for o caso).
const AMOSTRAS_MINIMAS = 1;

// Janela de histórico usada para estimar comissão/frete por SKU.
const DIAS_HISTORICO_PADRAO = 90;

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

// A partir de `buscarItensDoPeriodo` (lib/relatorioVendas.js — MESMA fonte
// usada em "Margem por Anúncio"), calcula por SKU a comissão média (como %
// do valor vendido) e o frete do vendedor médio por unidade, nos últimos ~90
// dias. Nunca usa item com tarifas/frete ausentes (calculado com dado
// faltando não é uma média confiável).
function calcularHistoricoPorSku(itensPeriodo) {
  const acumulador = new Map();
  (itensPeriodo || []).forEach((it) => {
    if (!it.sku) return;
    if (!acumulador.has(it.sku)) acumulador.set(it.sku, { tarifasPct: [], freteUnit: [] });
    const acc = acumulador.get(it.sku);
    if (it.tarifas !== null && it.valorTotalItem) acc.tarifasPct.push(it.tarifas / it.valorTotalItem);
    if (it.freteVendedor !== null && it.quantidade) acc.freteUnit.push(it.freteVendedor / it.quantidade);
  });

  const media = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  const resultado = new Map();
  acumulador.forEach((acc, sku) => {
    resultado.set(sku, {
      tarifasPctMedia: media(acc.tarifasPct),
      freteVendedorMedio: media(acc.freteUnit),
      amostras: Math.min(acc.tarifasPct.length, acc.freteUnit.length),
    });
  });
  return resultado;
}

// Descobre o preço promocional do item, conforme o formato que CADA tipo de
// promoção realmente devolve — confirmado com dado real da API em
// 13/09/2026 (nunca adivinhado):
//  - DEAL / SELLER_CAMPAIGN: original_price + faixa min/max/suggested_discounted_price
//  - SMART: original_price + price (preço já calculado daquela oferta específica) + meli_percentage/seller_percentage
//  - SELLER_COUPON_CAMPAIGN: original_price + fixed_percentage
function precoPromocionalDoItem(item) {
  if (item.suggested_discounted_price !== undefined && item.suggested_discounted_price !== null) {
    return { precoPromo: round2(Number(item.suggested_discounted_price)), origemPrecoPromo: 'suggested_discounted_price' };
  }
  if (item.price !== undefined && item.price !== null && item.original_price !== undefined && item.original_price !== null) {
    return { precoPromo: round2(Number(item.price)), origemPrecoPromo: 'price' };
  }
  if (item.fixed_percentage !== undefined && item.fixed_percentage !== null && item.original_price !== undefined && item.original_price !== null) {
    const p = round2(Number(item.original_price) * (1 - Number(item.fixed_percentage) / 100));
    return { precoPromo: p, origemPrecoPromo: 'fixed_percentage' };
  }
  if (item.max_discounted_price !== undefined && item.max_discounted_price !== null) {
    return { precoPromo: round2(Number(item.max_discounted_price)), origemPrecoPromo: 'max_discounted_price' };
  }
  return { precoPromo: null, origemPrecoPromo: null };
}

// Divide o desconto entre "bancado pelo Mercado Livre" e "bancado pelo
// vendedor" — pedido explícito do usuário. Só existe divisão real quando a
// própria API devolve `meli_percentage`/`seller_percentage` (visto até agora
// só no tipo SMART). Quando a API não informa a divisão, o desconto INTEIRO
// é tratado como bancado pelo vendedor — é a suposição mais conservadora
// (nunca subestima o quanto a promoção custa pro vendedor), nunca inventamos
// uma divisão que a API não confirmou.
function divisaoDesconto(item, precoNormal, precoPromo) {
  if (precoNormal === null || precoPromo === null || precoNormal <= 0) {
    return { descontoPct: null, descontoBancadoMeliPct: null, descontoBancadoVendedorPct: null };
  }
  const descontoPct = round2(((precoNormal - precoPromo) / precoNormal) * 100);
  const temDivisaoDaApi = item.meli_percentage !== undefined && item.meli_percentage !== null
    && item.seller_percentage !== undefined && item.seller_percentage !== null;
  if (temDivisaoDaApi) {
    return {
      descontoPct,
      descontoBancadoMeliPct: round2(Number(item.meli_percentage)),
      descontoBancadoVendedorPct: round2(Number(item.seller_percentage)),
    };
  }
  return { descontoPct, descontoBancadoMeliPct: null, descontoBancadoVendedorPct: descontoPct };
}

// Classificação do item, conforme pedido do usuário (5 estados possíveis).
// Regras determinísticas e explicáveis (nunca uma "caixa preta" da IA):
//  - dados insuficientes -> não dá pra confiar em nenhum número calculado
//  - item ainda não está na promoção (status "candidate"): ENTRAR (margem
//    ok), OPORTUNIDADE (margem folgada, bem acima do mínimo) ou NÃO
//    RECOMENDADO (margem abaixo do mínimo configurado)
//  - item já está de fato na promoção: MANTER (margem ok), RISCO DE MARGEM
//    (margem ok mas perto do limite mínimo) ou SAIR (margem abaixo do mínimo)
function classificar({ statusItem, margemIncompleta, margemPromoPct, margemMinimaPct }) {
  if (margemIncompleta || margemPromoPct === null || margemPromoPct === undefined) {
    return { codigo: 'dados_insuficientes', emoji: '⚠️', label: 'DADOS INSUFICIENTES' };
  }
  const minimo = Number(margemMinimaPct) || 0;
  const acimaDoMinimo = margemPromoPct >= minimo;
  const jaAtiva = !!statusItem && statusItem !== 'candidate';
  const limiteFolga = minimo > 0 ? minimo * 1.5 : 20;
  const limiteRisco = minimo > 0 ? minimo * 1.15 : 5;

  if (!jaAtiva) {
    if (!acimaDoMinimo) return { codigo: 'nao_recomendado', emoji: '🔴', label: 'NÃO RECOMENDADO' };
    if (margemPromoPct >= limiteFolga) return { codigo: 'oportunidade', emoji: '🔵', label: 'OPORTUNIDADE' };
    return { codigo: 'entrar', emoji: '🟢', label: 'ENTRAR' };
  }
  if (!acimaDoMinimo) return { codigo: 'sair', emoji: '🔴', label: 'SAIR' };
  if (margemPromoPct <= limiteRisco) return { codigo: 'risco_margem', emoji: '⚠️', label: 'RISCO DE MARGEM' };
  return { codigo: 'manter', emoji: '🟡', label: 'MANTER' };
}

// Analisa UM item de UMA promoção — junta preço (da própria promoção),
// catálogo ao vivo (título/imagem/SKU — lib/mlAnuncios.js), custo cadastrado
// (produtos.custo) e histórico de comissão/frete (calcularHistoricoPorSku) —
// e devolve a linha completa pronta para gravar em `promocoes_analises`.
function analisarItemPromocao({ item, catalogEntry, historicoPorSku, custoPorSku, aliquotaImposto, margemMinimaPct, contexto }) {
  const { precoPromo, origemPrecoPromo } = precoPromocionalDoItem(item);
  const precoNormal = item.original_price !== undefined && item.original_price !== null
    ? round2(Number(item.original_price))
    : (catalogEntry && catalogEntry.preco !== null && catalogEntry.preco !== undefined ? round2(Number(catalogEntry.preco)) : null);

  const sku = (catalogEntry && catalogEntry.sku) || null;
  const titulo = (catalogEntry && catalogEntry.titulo) || null;
  const imagemUrl = (catalogEntry && catalogEntry.imagemUrl) || null;

  const motivos = [];
  if (!sku) motivos.push('Não foi possível identificar o SKU deste anúncio no Mercado Livre.');
  if (precoPromo === null) motivos.push('O Mercado Livre não retornou um preço promocional utilizável para este item.');

  const custoProduto = sku && custoPorSku.has(sku) ? toNum(custoPorSku.get(sku)) : null;
  if (sku && custoProduto === null) motivos.push('Produto sem custo cadastrado (SKU ' + sku + ').');

  const historico = sku ? historicoPorSku.get(sku) : null;
  if (sku && (!historico || historico.amostras < AMOSTRAS_MINIMAS)) {
    motivos.push('Ainda não há vendas recentes suficientes deste SKU (últimos ' + DIAS_HISTORICO_PADRAO + ' dias) para estimar comissão e frete.');
  }

  const margemIncompleta = motivos.length > 0;

  let tarifasEstimadas = null;
  let freteVendedorEstimado = null;
  let impostoEstimado = null;
  let margemReal = null;
  let margemRealPct = null;

  if (!margemIncompleta) {
    tarifasEstimadas = round2(precoPromo * historico.tarifasPctMedia);
    freteVendedorEstimado = round2(historico.freteVendedorMedio);
    const calc = calcularResultadoVenda({
      valorVenda: precoPromo,
      taxaVenda: tarifasEstimadas,
      pagamentoTaxas: null,
      pagamentoTaxaMarketplace: null,
      freteVendedor: freteVendedorEstimado,
      custoProduto,
      aliquotaImposto,
      desconto: 0,
    });
    impostoEstimado = calc.imposto;
    margemReal = calc.resultado;
    margemRealPct = margemReal !== null && precoPromo ? round2((margemReal / precoPromo) * 100) : null;
  }

  const { descontoPct, descontoBancadoMeliPct, descontoBancadoVendedorPct } = divisaoDesconto(item, precoNormal, precoPromo);

  const classificacao = classificar({
    statusItem: item.status || null,
    margemIncompleta: margemIncompleta || margemRealPct === null,
    margemPromoPct: margemRealPct,
    margemMinimaPct,
  });

  return {
    ...contexto,
    mlItemId: item.id,
    statusItemMl: item.status || null,
    titulo,
    imagemUrl,
    sku,
    precoNormal,
    precoPromo,
    origemPrecoPromo,
    descontoPct,
    descontoBancadoMeliPct,
    descontoBancadoVendedorPct,
    custoProduto,
    tarifasEstimadas,
    freteVendedorEstimado,
    impostoEstimado,
    margemReal,
    margemRealPct,
    margemMinimaPctUsada: margemMinimaPct,
    margemIncompleta: margemIncompleta || margemRealPct === null,
    motivoIncompleto: motivos.length ? motivos.join(' ') : null,
    classificacaoCodigo: classificacao.codigo,
    classificacaoLabel: classificacao.label,
    classificacaoEmoji: classificacao.emoji,
  };
}

module.exports = {
  AMOSTRAS_MINIMAS,
  DIAS_HISTORICO_PADRAO,
  calcularHistoricoPorSku,
  precoPromocionalDoItem,
  divisaoDesconto,
  classificar,
  analisarItemPromocao,
};
