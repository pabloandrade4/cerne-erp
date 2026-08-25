// Radar da IA — análise contínua POR ANÚNCIO/SKU (Passo 1 do pedido do
// usuário, ver docs/02-decisoes.md). Só REGRAS e CÁLCULOS determinísticos
// aqui — nenhuma chamada ao modelo de IA neste arquivo (a interpretação em
// texto e a recomendação final ficam em lib/ia/radar.js, só para as
// situações que este módulo detecta). Mesma filosofia de sempre: nenhum
// cálculo financeiro novo — tudo em cima de lib/relatorioVendas.js
// (buscarItensDoPeriodo, a MESMA fonte de Pedidos/DRE/Financeiro/Ads) e
// lib/ads.js#listarAds (a MESMA fonte da tela Ads), só agregado por
// anúncio/SKU numa janela de tempo maior (para enxergar tendência).
const pool = require('../../db/pool');
const { buscarItensDoPeriodo } = require('../relatorioVendas');
const { listarAds } = require('../ads');
const { round2 } = require('../resultadoVenda');
const { diaBRT } = require('../periodo');
const CFG = require('./radarConfig');

const UM_DIA_MS = 24 * 60 * 60 * 1000;
const JANELA_HISTORICO_DIAS = 90; // só para enxergar "dias sem venda" de anúncios mais antigos/parados

function formatMoney(v) {
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function variacaoPct(atual, anterior) {
  if (atual === null || anterior === null || !anterior) return null;
  return round2(((atual - anterior) / Math.abs(anterior)) * 100);
}

// Agrupa os itens vendidos nos últimos 90 dias por anúncio (ml_item_id;
// quando o pedido não tiver ml_item_id — raro — cai para o SKU), separando
// em 3 janelas (30d / 7d / 7d imediatamente anteriores) na mesma passada,
// sem 3 consultas ao banco.
async function coletarVendasPorAnuncio(empresaId, agora) {
  const desde90 = new Date(agora.getTime() - JANELA_HISTORICO_DIAS * UM_DIA_MS);
  const desde30 = new Date(agora.getTime() - 30 * UM_DIA_MS);
  const desde7 = new Date(agora.getTime() - 7 * UM_DIA_MS);
  const desde14 = new Date(agora.getTime() - 14 * UM_DIA_MS);

  const { itens } = await buscarItensDoPeriodo({ empresaId, desde: desde90, ate: agora });
  const porAnuncio = new Map();

  itens.forEach((it) => {
    const chave = it.mlItemId ? ('ml:' + it.mlItemId) : (it.sku ? ('sku:' + it.sku) : null);
    if (!chave) return;
    if (!porAnuncio.has(chave)) {
      porAnuncio.set(chave, {
        chave, mlItemId: it.mlItemId, sku: it.sku, titulo: it.titulo, loja: it.loja,
        ultimaVendaEm: null,
        qtd30: 0, fat30: 0, tarifas30: 0, frete30: 0, imposto30: 0, custo30: 0, margem30: 0, pendentes30: 0, completos30: 0,
        qtd7: 0, fat7: 0, margem7: 0, pendentes7: 0, completos7: 0,
        qtdPrev7: 0, fatPrev7: 0,
      });
    }
    const acc = porAnuncio.get(chave);
    if (!acc.titulo && it.titulo) acc.titulo = it.titulo;
    if (!acc.sku && it.sku) acc.sku = it.sku;
    const dt = new Date(it.dataEfetiva);
    if (!acc.ultimaVendaEm || dt > acc.ultimaVendaEm) acc.ultimaVendaEm = dt;

    if (dt >= desde30) {
      acc.qtd30 += it.quantidade || 0;
      if (it.valorTotalItem !== null) acc.fat30 = round2(acc.fat30 + it.valorTotalItem);
      acc.tarifas30 = round2(acc.tarifas30 + (it.tarifas || 0));
      acc.frete30 = round2(acc.frete30 + (it.freteVendedor || 0));
      acc.imposto30 = round2(acc.imposto30 + (it.imposto || 0));
      acc.custo30 = round2(acc.custo30 + (it.custoProduto || 0));
      if (it.calculoCompleto) { acc.margem30 = round2(acc.margem30 + it.margemContribuicao); acc.completos30++; }
      else acc.pendentes30++;
    }
    if (dt >= desde7) {
      acc.qtd7 += it.quantidade || 0;
      if (it.valorTotalItem !== null) acc.fat7 = round2(acc.fat7 + it.valorTotalItem);
      if (it.calculoCompleto) { acc.margem7 = round2(acc.margem7 + it.margemContribuicao); acc.completos7++; }
      else acc.pendentes7++;
    } else if (dt >= desde14) {
      acc.qtdPrev7 += it.quantidade || 0;
      if (it.valorTotalItem !== null) acc.fatPrev7 = round2(acc.fatPrev7 + it.valorTotalItem);
    }
  });

  return porAnuncio;
}

// Estoque atual sincronizado (mesma fonte de Estoque/Estoque Full — nunca
// um dado pendente de sincronização entra como zero).
async function coletarEstoquePorAnuncio(empresaId) {
  const { rows } = await pool.query(
    `SELECT ml_item_id, sku, quantidade, pendente FROM ml_estoque_itens WHERE empresa_id = $1`,
    [empresaId]
  );
  const porMlItem = new Map();
  const porSku = new Map();
  rows.forEach((r) => {
    const disponivel = !r.pendente && r.quantidade !== null;
    const info = { disponivel, quantidade: disponivel ? Number(r.quantidade) : null };
    if (r.ml_item_id) porMlItem.set(r.ml_item_id, info);
    if (r.sku) porSku.set(r.sku, info);
  });
  return { porMlItem, porSku };
}

function buscarEstoque(estoque, mlItemId, sku) {
  if (mlItemId && estoque.porMlItem.has(mlItemId)) return estoque.porMlItem.get(mlItemId);
  if (sku && estoque.porSku.has(sku)) return estoque.porSku.get(sku);
  return null;
}

// Analisa continuamente cada anúncio/SKU da empresa e devolve a lista de
// "situações" detectadas (nunca uma ação — só a situação, com os números
// reais por trás). Cada situação já vem com um `chave` estável (usada por
// lib/ia/radar.js para nunca duplicar o mesmo alerta a cada ciclo) e uma
// `recomendacaoPadrao` (texto determinístico, sempre presente mesmo sem IA
// configurada — ver lib/ia/radar.js).
// `adsResultado30`/`adsResultado7` são opcionais — o chamador (lib/ia/radar.js)
// já busca Ads uma única vez por ciclo/empresa e compartilha o mesmo
// resultado com lib/ia/radarNegocio.js, pra nunca chamar a API do Mercado
// Ads em dobro no mesmo ciclo. Quando não informados, este módulo busca
// sozinho (usado pelos testes unitários deste arquivo).
async function analisarAnuncios({ empresaId, adsResultado30: adsResultado30Informado, adsResultado7: adsResultado7Informado }) {
  const agora = new Date();
  const [vendasPorAnuncio, estoque, adsResultado30, adsResultado7] = await Promise.all([
    coletarVendasPorAnuncio(empresaId, agora),
    coletarEstoquePorAnuncio(empresaId),
    adsResultado30Informado || listarAdsSeguro({ empresaId, dias: 30, agora }),
    adsResultado7Informado || listarAdsSeguro({ empresaId, dias: 7, agora }),
  ]);

  const adsPorAnuncio30 = new Map((adsResultado30.linhas || []).map((l) => [l.mlItemId ? ('ml:' + l.mlItemId) : ('sku:' + l.sku), l]));
  const adsPorAnuncio7 = new Map((adsResultado7.linhas || []).map((l) => [l.mlItemId ? ('ml:' + l.mlItemId) : ('sku:' + l.sku), l]));

  const situacoes = [];

  for (const [chave, v] of vendasPorAnuncio) {
    const nome = v.sku ? (v.titulo ? `${v.sku} (${v.titulo})` : v.sku) : (v.titulo || v.mlItemId || 'anúncio');
    const est = buscarEstoque(estoque, v.mlItemId, v.sku);
    const adsInfo30 = adsPorAnuncio30.get(chave) || null;
    const adsInfo7 = adsPorAnuncio7.get(chave) || null;

    const margemPct30 = v.pendentes30 === 0 && v.fat30 ? round2((v.margem30 / v.fat30) * 100) : null;
    const diasSemVenda = v.ultimaVendaEm ? Math.floor((agora.getTime() - v.ultimaVendaEm.getTime()) / UM_DIA_MS) : null;
    const investimentoAds30 = adsInfo30 ? adsInfo30.investimento : null;
    // adsInfo30.margemDepoisDoAds só existe quando lib/ads.js conseguiu um
    // investimento real (linha 295 de lib/ads.js) — quando o anúncio existe
    // em Ads mas SEM investimento no período (sem campanha vinculada, ou a
    // conta de Ads sem token válido — "sem_dado_ads"), essa margem também
    // vem null, mesmo com venda real e margem de contribuição conhecida.
    // Cair pro fallback só quando `adsInfo` não existe (bug encontrado nos
    // testes automatizados, ver test/radar.test.js) fazia a detecção de
    // "anúncio dando prejuízo" desaparecer silenciosamente em qualquer
    // empresa sem Ads conectado — sempre usar a margem pura de vendas
    // quando a margem depois do Ads não está disponível, não só quando não
    // há linha nenhuma de Ads pra esse anúncio.
    const margemDepoisDoAds30 = (adsInfo30 && adsInfo30.margemDepoisDoAds !== null) ? adsInfo30.margemDepoisDoAds : (v.pendentes30 === 0 ? v.margem30 : null);
    const investimentoAds7 = adsInfo7 ? adsInfo7.investimento : null;
    const margemDepoisDoAds7 = (adsInfo7 && adsInfo7.margemDepoisDoAds !== null) ? adsInfo7.margemDepoisDoAds : (v.pendentes7 === 0 ? v.margem7 : null);
    const variacaoQtd7 = variacaoPct(v.qtd7, v.qtdPrev7);
    const variacaoFat7 = variacaoPct(v.fat7, v.fatPrev7);
    const precoMedio30 = v.qtd30 > 0 ? round2(v.fat30 / v.qtd30) : null;

    const dadosBase = {
      chaveAnuncio: chave, mlItemId: v.mlItemId, sku: v.sku, titulo: v.titulo, loja: v.loja,
      quantidadeVendida30d: v.qtd30, faturamento30d: v.fat30, margemContribuicao30d: v.pendentes30 === 0 ? v.margem30 : null,
      margemPercentual30d: margemPct30, diasSemVenda,
      estoqueDisponivel: est ? est.quantidade : null, estoqueSincronizado: !!(est && est.disponivel),
      precoMedioVenda30d: precoMedio30,
      taxasEComissoes30d: v.tarifas30, freteDoVendedor30d: v.frete30, imposto30d: v.imposto30, custoDoProduto30d: v.custo30,
      investimentoAds30d: investimentoAds30, margemDepoisDoAds30d: margemDepoisDoAds30,
      investimentoAds7d: investimentoAds7, faturamento7d: v.fat7, margemDepoisDoAds7d: margemDepoisDoAds7,
      variacaoQuantidade7dPct: variacaoQtd7, variacaoFaturamento7dPct: variacaoFat7,
    };

    // Só considera "ativo o suficiente pra analisar" quando há pelo menos
    // uma venda nos últimos 90 dias OU o anúncio está sincronizado no
    // estoque (evita gerar alerta de "anúncio parado" pra um SKU antigo
    // que nunca existiu como anúncio de verdade, sem histórico nem estoque).
    const anuncioRelevante = v.ultimaVendaEm !== null || (est && est.disponivel);
    if (!anuncioRelevante) continue;

    // ---- 1) Vendendo pouco / praticamente parado ----
    if (diasSemVenda !== null && diasSemVenda >= CFG.ANUNCIO_DIAS_SEM_VENDA_PARADO && (!est || est.quantidade === null || est.quantidade > 0)) {
      situacoes.push({
        chave: 'anuncio_parado:' + chave, categoria: 'anuncio_parado', severidade: 'atencao',
        titulo: `${nome} está parado há ${diasSemVenda} dias`,
        descricao: `Este anúncio está há ${diasSemVenda} dias sem nenhuma venda registrada. ${v.qtd30 > 0 ? `Vendeu ${v.qtd30} unidade(s) nos últimos 30 dias.` : 'Nenhuma venda nos últimos 30 dias.'}`,
        recomendacaoPadrao: `Este anúncio está há ${diasSemVenda} dias com desempenho muito baixo. Se não houver motivo estratégico para mantê-lo, considere melhorar a oferta (preço, título, fotos, concorrência e exposição) ou avaliar desativá-lo — a IA não desativa nada sozinha, essa decisão é sua.`,
        pagina: 'ads', dados: dadosBase, valorEnvolvido: v.fat30 || null,
      });
    } else if (v.qtd30 > 0 && v.qtd30 <= CFG.ANUNCIO_VENDA_BAIXA_QTD_30D && diasSemVenda !== null && diasSemVenda >= CFG.ANUNCIO_DIAS_SEM_VENDA_ATENCAO) {
      situacoes.push({
        chave: 'anuncio_venda_baixa:' + chave, categoria: 'anuncio_venda_baixa', severidade: 'atencao',
        titulo: `${nome} vendeu apenas ${v.qtd30} unidade(s) nos últimos 30 dias`,
        descricao: `O anúncio ${nome} vendeu apenas ${v.qtd30} unidade${v.qtd30 === 1 ? '' : 's'} nos últimos 30 dias e ficou ${diasSemVenda} dias sem nenhuma venda.`,
        recomendacaoPadrao: 'Esse anúncio merece revisão. Verifique preço, título, fotos, concorrência e exposição.',
        pagina: 'ads', dados: dadosBase, valorEnvolvido: v.fat30 || null,
      });
    }

    // ---- 2) Muito faturamento e pouco resultado ----
    if (v.fat30 >= CFG.ANUNCIO_FATURAMENTO_RELEVANTE_30D && margemPct30 !== null && margemPct30 >= 0 && margemPct30 < CFG.ANUNCIO_MARGEM_BAIXA_PCT) {
      situacoes.push({
        chave: 'anuncio_faturamento_baixa_margem:' + chave, categoria: 'anuncio_faturamento_baixa_margem', severidade: 'atencao',
        titulo: `${nome} faturou ${formatMoney(v.fat30)} mas deixou pouca margem`,
        descricao: `Este anúncio faturou ${formatMoney(v.fat30)} nos últimos 30 dias, mas depois de taxas (${formatMoney(v.tarifas30)}), frete do vendedor (${formatMoney(v.frete30)}), imposto (${formatMoney(v.imposto30)}) e custo do produto (${formatMoney(v.custo30)})${investimentoAds30 ? ` e Ads (${formatMoney(investimentoAds30)})` : ''}, gerou ${formatMoney(margemDepoisDoAds30 !== null ? margemDepoisDoAds30 : v.margem30)} de margem — ${margemPct30.toLocaleString('pt-BR')}% do faturamento.`,
        recomendacaoPadrao: 'A margem está saudável em % mas o resultado em reais é pequeno perto do volume vendido. Vale revisar preço, custo do produto ou o investimento em Ads deste anúncio.',
        pagina: 'ads', dados: dadosBase, valorEnvolvido: v.fat30 || null,
      });
    }

    // ---- 3) Prejuízo (últimos 7 dias, depois de Ads quando houver) ----
    if (margemDepoisDoAds7 !== null && margemDepoisDoAds7 < 0 && v.qtd7 > 0) {
      situacoes.push({
        chave: 'anuncio_prejuizo:' + chave, categoria: 'anuncio_prejuizo', severidade: 'critico',
        titulo: `${nome} teve resultado de ${formatMoney(margemDepoisDoAds7)} nos últimos 7 dias`,
        descricao: `O anúncio ${nome} teve resultado de ${formatMoney(margemDepoisDoAds7)} nos últimos 7 dias. Faturamento: ${formatMoney(v.fat7)}${investimentoAds7 ? `; investimento em Ads: ${formatMoney(investimentoAds7)}` : ''}; margem de contribuição antes do Ads: ${formatMoney(v.margem7)}.`,
        recomendacaoPadrao: 'Este anúncio está dando prejuízo real na janela recente. Revise preço, custo cadastrado, frete e — se houver Ads ativo — o investimento em publicidade deste anúncio antes de continuar vendendo nesse ritmo.',
        pagina: 'ads', dados: dadosBase, valorEnvolvido: Math.abs(margemDepoisDoAds7),
      });
    }

    // ---- 4) Oportunidades: crescimento e bom desempenho ----
    if (variacaoQtd7 !== null && variacaoQtd7 >= CFG.ANUNCIO_CRESCIMENTO_PCT_7D && margemPct30 !== null && margemPct30 >= CFG.ANUNCIO_MARGEM_SAUDAVEL_PCT) {
      situacoes.push({
        chave: 'anuncio_crescimento:' + chave, categoria: 'anuncio_crescimento', severidade: 'oportunidade',
        titulo: `${nome} cresceu ${variacaoQtd7.toLocaleString('pt-BR')}% e manteve margem de ${margemPct30.toLocaleString('pt-BR')}%`,
        descricao: `O anúncio ${nome} vendeu ${variacaoQtd7 >= 0 ? variacaoQtd7.toLocaleString('pt-BR') + '% a mais' : ''} nos últimos 7 dias comparado aos 7 dias anteriores, mantendo margem de ${margemPct30.toLocaleString('pt-BR')}% nos últimos 30 dias.`,
        recomendacaoPadrao: 'Esse crescimento com margem saudável é uma oportunidade — considere reforçar estoque e, se fizer sentido, aumentar a exposição/investimento neste anúncio.',
        pagina: 'ads', dados: dadosBase, valorEnvolvido: v.fat30 || null,
      });
    } else if (v.fat30 >= CFG.ANUNCIO_BOM_DESEMPENHO_FATURAMENTO_30D && margemPct30 !== null && margemPct30 >= CFG.ANUNCIO_MARGEM_SAUDAVEL_PCT && v.qtd30 > CFG.ANUNCIO_VENDA_BAIXA_QTD_30D) {
      situacoes.push({
        chave: 'anuncio_bom_desempenho:' + chave, categoria: 'anuncio_bom_desempenho', severidade: 'oportunidade',
        titulo: `${nome} está vendendo bem e possui margem saudável`,
        descricao: `O anúncio ${nome} faturou ${formatMoney(v.fat30)} nos últimos 30 dias (${v.qtd30} unidades), com margem de ${margemPct30.toLocaleString('pt-BR')}%.`,
        recomendacaoPadrao: 'Bom desempenho consistente — vale manter o estoque abastecido e observar se há espaço para crescer ainda mais este anúncio.',
        pagina: 'ads', dados: dadosBase, valorEnvolvido: v.fat30 || null,
      });
    }
  }

  return situacoes;
}

// Ads pode não estar conectado (sem conta) — nunca deixa o radar quebrar
// por isso, mesma regra defensiva já usada no resto do ERP.
async function listarAdsSeguro({ empresaId, dias, agora }) {
  try {
    const desde = new Date(agora.getTime() - dias * UM_DIA_MS);
    const desdeStr = diaBRT(desde), ateStr = diaBRT(agora);
    const mesDesde = new Date(agora.getFullYear(), agora.getMonth(), 1);
    return await listarAds({
      empresaId, contaId: null, desde, ate: agora, desdeStr, ateStr,
      mesDesdeStr: diaBRT(mesDesde), mesAteStr: ateStr, hojeStr: diaBRT(agora),
    });
  } catch (e) {
    console.error('[radar da ia] falha ao consultar Ads (' + dias + 'd) — seguindo sem dado de Ads: ' + e.message);
    return { semConta: true, linhas: [] };
  }
}

module.exports = { analisarAnuncios, listarAdsSeguro };
