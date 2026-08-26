// Aba "Margem por Anúncio" (Análise) — criada em 26/08/2026, pedido
// explícito do usuário: "Use a mesma regra financeira de Pedidos,
// Financeiro e Relatórios. Não crie uma nova fórmula específica para essa
// página." Por isso este arquivo NÃO recalcula nada: agrupa por anúncio os
// mesmos ITENS de pedido já calculados por lib/relatorioVendas.js (via
// lib/anunciosBase.js#agruparVendasDetalhado, que usa
// lib/resultadoVenda.js) e o investimento em Ads já sincronizado (mesma
// fonte da tela Ads — lib/ads.js#buscarMetricasPorAnuncio).
//
// FÓRMULA (idêntica à usada em Pedidos/Financeiro/Relatórios/Ads):
//   FATURAMENTO − tarifas/comissões − frete do vendedor − imposto − custo
//   dos produtos = MARGEM DE CONTRIBUIÇÃO (antes do Ads)
//   MARGEM DE CONTRIBUIÇÃO − ADS = RESULTADO APÓS ADS
//
// Sobre "imposto ausente" (pedido do usuário: "Se algum SKU estiver sem
// custo ou imposto, sinalize claramente que a margem está incompleta"):
// neste ERP o imposto é uma ALÍQUOTA ÚNICA POR EMPRESA (config_financeiro,
// não por SKU — ver lib/resultadoVenda.js), sempre aplicada quando o valor
// da venda existe. Por isso, no modelo de dados atual, "imposto ausente por
// SKU" não é uma situação que pode ocorrer de verdade — documentado aqui
// para não inventar uma sinalização que o próprio sistema nunca produz. A
// causa real de margem incompleta hoje é sempre CUSTO do produto não
// cadastrado em Produtos (mesmo sinal — `pendentes`/`margemIncompleta` — já
// usado em Pedidos, Relatórios e Ads). Se um dia o imposto passar a ser
// calculado por SKU, esta tela precisa ser revisada.
//
// ============================================================================
// DESTAQUES OBJETIVOS (pedido do usuário: "Destacar anúncios que...") — os
// mesmos limiares abaixo estão documentados em docs/01-regras-de-negocio.md.
// Faturamento e quantidade vendida são comparados aos anúncios do MESMO
// resultado (empresa/loja/período filtrados) por TERÇOS (top 1/3 = "alto",
// 1/3 inferior = "baixo") — uma régua relativa, já que "fatura muito" ou
// "vende pouco" só faz sentido comparado aos outros anúncios do mesmo
// conjunto, nunca um valor fixo em reais que funcionaria para uma empresa
// pequena e não para uma grande.
//   - "Fatura muito, mas deixa pouca margem": faturamento no terço de cima
//     do conjunto E margemContribuicaoPct <= MARGEM_BAIXA_PCT (10%).
//   - "Margem negativa": margemContribuicao < 0.
//   - "Prejuízo após Ads": resultadoAposAds < 0 (mesmo com margem >= 0).
//   - "Ads consumindo grande parte do resultado": investimento em Ads >=
//     ADS_CONSOME_PCT (50%) da margem de contribuição (só quando a margem é
//     positiva — se já é negativa, o destaque é "Margem negativa").
//   - "Vende pouco, mas ótima margem": quantidade vendida no terço de baixo
//     do conjunto E margemContribuicaoPct >= MARGEM_OTIMA_PCT (30%).
//   - "Vende muito com margem saudável": quantidade vendida no terço de
//     cima do conjunto E margemContribuicaoPct >= MARGEM_SAUDAVEL_PCT (15%).
// ============================================================================
const { round2 } = require('./resultadoVenda');
const { buscarItensDoPeriodo } = require('./relatorioVendas');
const { buscarMetricasPorAnuncio } = require('./ads');
const { agruparVendasDetalhado, buscarNomesProdutoPorSku, buscarContasFiltradas } = require('./anunciosBase');

const MARGEM_BAIXA_PCT = 10;
const ADS_CONSOME_PCT = 50;
const MARGEM_OTIMA_PCT = 30;
const MARGEM_SAUDAVEL_PCT = 15;

const CRITERIOS = {
  margemBaixaPct: MARGEM_BAIXA_PCT,
  adsConsomePct: ADS_CONSOME_PCT,
  margemOtimaPct: MARGEM_OTIMA_PCT,
  margemSaudavelPct: MARGEM_SAUDAVEL_PCT,
  descricao: 'Faturamento e quantidade vendida são comparados por terços dentro do próprio conjunto filtrado (empresa/loja/período) — documentado em docs/01-regras-de-negocio.md.',
};

// Devolve o valor de corte do terço de cima e do terço de baixo de uma lista
// de números (>=0 apenas, ignorando null) — usado para "fatura muito"/"vende
// pouco" relativos ao próprio conjunto filtrado.
function limiaresPorTercos(valores) {
  const validos = valores.filter((v) => v !== null && v !== undefined).slice().sort((a, b) => a - b);
  if (validos.length < 3) return { corteBaixo: null, corteAlto: null };
  const corteBaixo = validos[Math.floor(validos.length / 3) - 1] ?? validos[0];
  const corteAlto = validos[Math.ceil((validos.length * 2) / 3)] ?? validos[validos.length - 1];
  return { corteBaixo, corteAlto };
}

async function gerarMargemPorAnuncio({ empresaId, contaId, sku, periodoCalc, periodoChaveAds }) {
  const { contasTodas, contasFiltradas } = await buscarContasFiltradas({ empresaId, contaId });
  if (!contasTodas.length) {
    return { semConta: true, lojas: [], linhas: [], periodo: null, criterios: CRITERIOS };
  }

  const { desde, ate } = periodoCalc;
  const contaIdsAtivas = contasFiltradas.filter((c) => c.status === 'ativa').map((c) => c.id);

  const [{ itens }, investimentoPorAnuncio] = await Promise.all([
    buscarItensDoPeriodo({ empresaId, desde, ate }),
    buscarMetricasPorAnuncio(contaIdsAtivas, periodoChaveAds || '30d'),
  ]);

  const itensFiltrados = contaId ? itens.filter((it) => String(it.contaMlId) === String(contaId)) : itens;
  const vendas = agruparVendasDetalhado(itensFiltrados);

  const skus = [...vendas.values()].map((v) => v.sku);
  const nomesProduto = await buscarNomesProdutoPorSku(empresaId, skus);

  let linhas = [...vendas.entries()].map(([chave, v]) => {
    const ads = v.mlItemId ? investimentoPorAnuncio.get(v.mlItemId) : null;
    const investimentoAds = ads ? ads.investimento : null;

    const margemContribuicaoPct = (v.margemContribuicao !== null && v.faturamento) ? round2((v.margemContribuicao / v.faturamento) * 100) : null;
    const resultadoAposAds = (v.margemContribuicao !== null && investimentoAds !== null) ? round2(v.margemContribuicao - investimentoAds) : null;
    const margemAposAdsPct = (resultadoAposAds !== null && v.faturamento) ? round2((resultadoAposAds / v.faturamento) * 100) : null;

    return {
      mlItemId: v.mlItemId,
      anuncio: v.titulo,
      sku: v.sku,
      produto: v.sku ? (nomesProduto.get(v.sku) || null) : null,
      loja: v.loja,
      contaMlId: v.contaMlId,
      quantidadeVendida: v.quantidade,
      faturamento: v.faturamento,
      custoProdutos: v.custoProduto,
      imposto: v.imposto,
      tarifas: v.tarifas,
      freteVendedor: v.freteVendedor,
      margemContribuicao: v.margemContribuicao,
      margemContribuicaoPct,
      investimentoAds,
      resultadoAposAds,
      margemAposAdsPct,
      margemIncompleta: v.margemIncompleta,
      semDadosAds: !ads,
      rateado: v.rateado,
    };
  });

  if (sku) {
    const alvo = sku.trim().toLowerCase();
    linhas = linhas.filter((l) => (l.sku || '').toLowerCase().includes(alvo));
  }

  const { corteBaixo: corteBaixoFaturamento, corteAlto: corteAltoFaturamento } = limiaresPorTercos(linhas.map((l) => l.faturamento));
  const { corteBaixo: corteBaixoQtd, corteAlto: corteAltoQtd } = limiaresPorTercos(linhas.map((l) => l.quantidadeVendida));

  linhas = linhas.map((l) => {
    const faturaMuitoNoTopo = corteAltoFaturamento !== null && l.faturamento >= corteAltoFaturamento;
    const vendeQuantidadeNoTopo = corteAltoQtd !== null && l.quantidadeVendida >= corteAltoQtd;
    const vendePoucoNoFundo = corteBaixoQtd !== null && l.quantidadeVendida <= corteBaixoQtd;

    const destaques = {
      faturaMuitoPoucaMargem: faturaMuitoNoTopo && l.margemContribuicaoPct !== null && l.margemContribuicaoPct <= MARGEM_BAIXA_PCT,
      margemNegativa: l.margemContribuicao !== null && l.margemContribuicao < 0,
      prejuizoAposAds: l.resultadoAposAds !== null && l.resultadoAposAds < 0 && !(l.margemContribuicao !== null && l.margemContribuicao < 0),
      adsConsumindoResultado: l.investimentoAds !== null && l.margemContribuicao !== null && l.margemContribuicao > 0 && l.investimentoAds >= l.margemContribuicao * (ADS_CONSOME_PCT / 100),
      vendePoucoOtimaMargem: vendePoucoNoFundo && l.margemContribuicaoPct !== null && l.margemContribuicaoPct >= MARGEM_OTIMA_PCT,
      vendeMuitoMargemSaudavel: vendeQuantidadeNoTopo && l.margemContribuicaoPct !== null && l.margemContribuicaoPct >= MARGEM_SAUDAVEL_PCT,
    };
    return { ...l, destaques };
  });

  return {
    semConta: false,
    lojas: contasTodas.map((c) => ({ id: c.id, nickname: c.nickname })),
    periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde, ate },
    linhas,
    criterios: CRITERIOS,
  };
}

module.exports = { gerarMargemPorAnuncio, CRITERIOS };
