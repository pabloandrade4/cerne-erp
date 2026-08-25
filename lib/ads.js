// Ads (Product Ads do Mercado Livre) — ativado em 25/08/2026, corrigido em
// 25/08/2026 (ver docs/04-alteracoes.md, entrada de correção da tela Ads):
// endpoint/parâmetros da API real corrigidos em lib/mlAds.js, e adicionados
// os cards de topo (gasto hoje/mês), o gráfico diário e a divisão em duas
// visões separadas (performance atribuída x resultado real do SKU).
//
// Duas fontes bem separadas, NUNCA misturadas numa fórmula nova:
// 1) Métricas de publicidade (investimento, vendas/receita atribuída, ROAS,
//    ACOS, série diária) vêm SEMPRE da API de Advertising do Mercado Livre
//    (lib/mlAds.js), nunca calculadas pelo ERP — se a conta não tiver
//    acesso a Product Ads, ou a API falhar, aparecem como indisponíveis
//    (nunca um número inventado). ROAS/ACOS por anúncio são a única conta
//    feita aqui em cima desses números — divisão de dois valores reais
//    (receita atribuída ÷ investimento), não uma estimativa.
// 2) Lucro/margem "antes do Ads" vem da mesma fonte única de sempre
//    (lib/relatorioVendas.js → buscarItensDoPeriodo, que reaproveita
//    lib/resultadoVenda.js) — a margem de contribuição REAL das vendas
//    daquele anúncio no período, idêntica à filosofia de Pedidos/DRE/
//    Financeiro. "Depois do Ads" = essa margem real menos o investimento
//    real em Ads (fonte 1). TACOS = investimento em Ads (fonte 1) dividido
//    pelo faturamento REAL das vendas daquele anúncio no período (fonte 2)
//    — só calculado quando os dois números existem, nunca estimado.
//
// IMPORTANTE (pedido explícito do usuário): a API de Advertising do
// Mercado Livre não identifica QUAIS PEDIDOS pertencem à publicidade —
// só devolve totais agregados atribuídos por anúncio/dia (ver
// docs/02-decisoes.md). Por isso nunca chamamos "vendas atribuídas" (fonte
// 1) de "lucro gerado pelo Ads": a tela mostra duas visões SEPARADAS
// (window.Ads no frontend) — "Performance atribuída Mercado Ads" (só fonte
// 1) e "Resultado real do SKU após Ads" (fonte 2 menos o investimento da
// fonte 1, deixando explícito que pode incluir venda orgânica).
const pool = require('../db/pool');
const { decrypt } = require('./crypto');
const { buscarDadosAdsDaConta } = require('./mlAds');
const { buscarItensDoPeriodo } = require('./relatorioVendas');
const { round2 } = require('./resultadoVenda');

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

function somarSeAmbos(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return round2(Number(a) + Number(b));
}

// Agrupa nossos itens de pedido (já com margem real calculada, um por
// linha/pedido) por anúncio (ml_item_id) — soma vendas/faturamento/margem
// de todos os pedidos daquele anúncio no período.
function agruparVendasPorAnuncio(itensPedidos) {
  const porAnuncio = new Map();
  itensPedidos.forEach((it) => {
    const chave = it.mlItemId || `sem-id:${it.sku || 's-sku'}:${it.contaMlId}`;
    if (!porAnuncio.has(chave)) {
      porAnuncio.set(chave, {
        mlItemId: it.mlItemId,
        sku: it.sku,
        titulo: it.titulo,
        loja: it.loja,
        contaMlId: it.contaMlId,
        quantidade: 0,
        faturamento: 0,
        margemContribuicao: 0,
        pendentes: 0,
        rateado: false,
      });
    }
    const acc = porAnuncio.get(chave);
    acc.quantidade += it.quantidade || 0;
    if (it.valorTotalItem !== null) acc.faturamento = round2(acc.faturamento + it.valorTotalItem);
    if (it.calculoCompleto) acc.margemContribuicao = round2(acc.margemContribuicao + it.margemContribuicao);
    else acc.pendentes += 1;
    if (it.rateado) acc.rateado = true;
    if (!acc.titulo && it.titulo) acc.titulo = it.titulo;
    if (!acc.sku && it.sku) acc.sku = it.sku;
  });
  return porAnuncio;
}

// Extrai investimento/receita atribuída/qtd atribuída de um objeto de
// métricas cru da API (item, ou linha diária) — mesma regra de fallback
// nos dois casos: total_amount quando existe, senão a soma de
// direct+indirect (só quando os dois vierem, nunca metade estimada).
function extrairInvestimentoEReceita(metrics) {
  const investimento = toNum(metrics.cost);
  const receita = toNum(metrics.total_amount) !== null
    ? toNum(metrics.total_amount)
    : somarSeAmbos(metrics.direct_amount, metrics.indirect_amount);
  const qtd = toNum(metrics.units_quantity) !== null
    ? toNum(metrics.units_quantity)
    : somarSeAmbos(metrics.direct_units_quantity, metrics.indirect_units_quantity);
  return { investimento, receita, qtd };
}

// Soma duas séries diárias {data, investimento, receitaAtribuida} numa só,
// somando os valores dos mesmos dias — usado pra combinar a série de
// várias contas/lojas da mesma empresa. Um dia ausente numa conta não
// derruba o dia inteiro: soma só o que existir.
function somarSeriesDiarias(destino, origem) {
  origem.forEach((dia) => {
    let alvo = destino.find((d) => d.data === dia.data);
    if (!alvo) { alvo = { data: dia.data, investimento: null, receitaAtribuida: null }; destino.push(alvo); }
    if (dia.investimento !== null) alvo.investimento = round2((alvo.investimento || 0) + dia.investimento);
    if (dia.receitaAtribuida !== null) alvo.receitaAtribuida = round2((alvo.receitaAtribuida || 0) + dia.receitaAtribuida);
  });
}

function converterDiasCrus(diasCrus) {
  if (!diasCrus) return [];
  return diasCrus.map((d) => {
    const metrics = d.metrics_summary || d.metrics || d;
    const { investimento, receita } = extrairInvestimentoEReceita(metrics);
    return { data: d.date, investimento, receitaAtribuida: receita };
  }).filter((d) => d.data);
}

// Consulta os dados reais de Ads (itens, campanhas, séries diárias) de
// todas as contas elegíveis — uma conta com erro/sem acesso não impede as
// demais de mostrar dado real (cada uma tem sua própria situação, nunca
// uma decisão "tudo ou nada").
async function buscarMetricasDeTodasAsContas(contas, { periodoDesdeStr, periodoAteStr, mesDesdeStr, mesAteStr }) {
  const situacaoPorConta = [];
  const metricasPorAnuncio = new Map();
  const diarioPeriodoTotal = [];
  const diarioMesTotal = [];
  let algumaContaComDiarioPeriodo = false;
  let algumaContaComDiarioMes = false;

  for (const conta of contas) {
    if (conta.status !== 'ativa') {
      situacaoPorConta.push({
        contaId: conta.id, loja: conta.nickname, disponivel: false,
        motivo: 'conta_com_erro',
        mensagem: 'A conexão desta conta com o Mercado Livre está com erro ou desconectada. Reconecte em Marketplaces.',
      });
      continue;
    }
    let accessToken;
    try {
      accessToken = decrypt(conta.access_token_enc);
    } catch (e) {
      situacaoPorConta.push({
        contaId: conta.id, loja: conta.nickname, disponivel: false,
        motivo: 'erro_api', mensagem: 'Não foi possível ler o token de acesso desta conta.',
      });
      continue;
    }

    const resultado = await buscarDadosAdsDaConta({
      accessToken, periodoDesde: periodoDesdeStr, periodoAte: periodoAteStr, mesDesde: mesDesdeStr, mesAte: mesAteStr,
    });
    if (!resultado.disponivel) {
      situacaoPorConta.push({ contaId: conta.id, loja: conta.nickname, disponivel: false, motivo: resultado.motivo, mensagem: resultado.mensagem });
      continue;
    }
    situacaoPorConta.push({ contaId: conta.id, loja: conta.nickname, disponivel: true });

    const campanhaPorId = new Map((resultado.campanhas || []).map((c) => [String(c.id), c.name || null]));

    resultado.itens.forEach((item) => {
      const metrics = item.metrics_summary || item.metrics || {};
      const { investimento, receita: faturamentoAtribuido, qtd: qtdVendasAtribuidas } = extrairInvestimentoEReceita(metrics);

      metricasPorAnuncio.set(String(item.item_id || item.id), {
        contaMlId: conta.id,
        loja: conta.nickname,
        titulo: item.title || null,
        campanha: item.campaign_id !== undefined && item.campaign_id !== null ? (campanhaPorId.get(String(item.campaign_id)) || null) : null,
        investimento,
        faturamentoAtribuido,
        qtdVendasAtribuidas,
        clicks: toNum(metrics.clicks),
        prints: toNum(metrics.prints),
        cpc: toNum(metrics.cpc),
        acosApi: toNum(metrics.acos),
      });
    });

    if (resultado.diarioPeriodo) {
      algumaContaComDiarioPeriodo = true;
      somarSeriesDiarias(diarioPeriodoTotal, converterDiasCrus(resultado.diarioPeriodo));
    }
    if (resultado.diarioMes) {
      algumaContaComDiarioMes = true;
      somarSeriesDiarias(diarioMesTotal, converterDiasCrus(resultado.diarioMes));
    }
  }

  diarioPeriodoTotal.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  diarioMesTotal.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));

  return {
    situacaoPorConta,
    metricasPorAnuncio,
    diarioPeriodo: algumaContaComDiarioPeriodo ? diarioPeriodoTotal : null,
    diarioMes: algumaContaComDiarioMes ? diarioMesTotal : null,
  };
}

// Cards de topo: Gasto hoje / Gasto no mês vêm da série diarioMes (janela
// fixa dia-1-do-mês-até-hoje, independente do período escolhido no filtro
// da tela). Receita atribuída/ROAS/ACOS do período vêm da soma das linhas
// (mesma fonte da tabela — nunca um segundo cálculo que possa divergir).
function calcularCards({ diarioMes, hojeStr, linhas, situacaoPorConta }) {
  const algumaDisponivel = situacaoPorConta.some((s) => s.disponivel);
  const todasIndisponiveis = situacaoPorConta.length > 0 && !algumaDisponivel;

  let gastoHoje = null, gastoMes = null;
  if (diarioMes && diarioMes.length) {
    const diasComInvestimento = diarioMes.filter((d) => d.investimento !== null);
    gastoMes = diasComInvestimento.length ? round2(diasComInvestimento.reduce((s, d) => s + d.investimento, 0)) : null;
    const hoje = diarioMes.find((d) => d.data === hojeStr);
    gastoHoje = hoje && hoje.investimento !== null ? hoje.investimento : null;
  }

  const linhasComInvestimento = linhas.filter((l) => l.investimento !== null);
  const investimentoPeriodo = linhasComInvestimento.length ? round2(linhasComInvestimento.reduce((s, l) => s + l.investimento, 0)) : null;
  const linhasComReceita = linhas.filter((l) => l.faturamentoAtribuido !== null);
  const receitaAtribuidaPeriodo = linhasComReceita.length ? round2(linhasComReceita.reduce((s, l) => s + l.faturamentoAtribuido, 0)) : null;

  const roasPeriodo = (investimentoPeriodo && investimentoPeriodo > 0 && receitaAtribuidaPeriodo !== null)
    ? round2(receitaAtribuidaPeriodo / investimentoPeriodo) : null;
  const acosPeriodo = (investimentoPeriodo !== null && receitaAtribuidaPeriodo)
    ? round2((investimentoPeriodo / receitaAtribuidaPeriodo) * 100) : null;

  return {
    disponivel: !todasIndisponiveis,
    parcial: situacaoPorConta.some((s) => !s.disponivel) && algumaDisponivel,
    gastoHoje,
    gastoMes,
    investimentoPeriodo,
    receitaAtribuidaPeriodo,
    roasPeriodo,
    acosPeriodo,
  };
}

// GET principal usado por routes/ads.js — devolve linha por anúncio
// (união do que existe em vendas reais e/ou em métricas de Ads reais, pra
// nunca esconder um anúncio que só aparece de um dos dois lados), os cards
// de topo, a série diária do gráfico e a situação de sincronização por
// loja.
async function listarAds({ empresaId, contaId, desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr }) {
  const { rows: contasTodas } = await pool.query(
    'SELECT * FROM ml_contas WHERE empresa_id = $1 ORDER BY nickname',
    [empresaId]
  );
  if (!contasTodas.length) {
    return {
      semConta: true,
      lojas: [],
      situacaoPorConta: [],
      linhas: [],
      cards: { disponivel: false, parcial: false, gastoHoje: null, gastoMes: null, investimentoPeriodo: null, receitaAtribuidaPeriodo: null, roasPeriodo: null, acosPeriodo: null },
      diario: [],
    };
  }

  const contasFiltradas = contaId ? contasTodas.filter((c) => String(c.id) === String(contaId)) : contasTodas;

  const { itens: itensPedidos } = await buscarItensDoPeriodo({ empresaId, desde, ate });
  const itensPedidosFiltrados = contaId ? itensPedidos.filter((it) => String(it.contaMlId) === String(contaId)) : itensPedidos;
  const vendasPorAnuncio = agruparVendasPorAnuncio(itensPedidosFiltrados);

  const { situacaoPorConta, metricasPorAnuncio, diarioPeriodo, diarioMes } = await buscarMetricasDeTodasAsContas(contasFiltradas, {
    periodoDesdeStr: desdeStr, periodoAteStr: ateStr, mesDesdeStr, mesAteStr,
  });

  const chaves = new Set([...vendasPorAnuncio.keys(), ...metricasPorAnuncio.keys()]);
  const linhas = [...chaves].map((chave) => {
    const venda = vendasPorAnuncio.get(chave) || null;
    const ads = metricasPorAnuncio.get(chave) || null;

    const investimento = ads ? ads.investimento : null;
    const faturamentoAtribuido = ads ? ads.faturamentoAtribuido : null;
    const qtdVendasAtribuidas = ads ? ads.qtdVendasAtribuidas : null;

    // ROAS não é uma métrica documentada no endpoint de itens (só existe em
    // campanhas — ver lib/mlAds.js) — calculado aqui em cima de dois
    // números reais (receita atribuída ÷ investimento), nunca uma
    // estimativa.
    const roas = investimento && investimento > 0 && faturamentoAtribuido !== null
      ? round2(faturamentoAtribuido / investimento)
      : null;
    const acos = ads && ads.acosApi !== null
      ? ads.acosApi
      : (investimento !== null && faturamentoAtribuido ? round2((investimento / faturamentoAtribuido) * 100) : null);

    const faturamentoRealAnuncio = venda ? venda.faturamento : null;
    // TACOS = investimento em Ads / faturamento REAL do anúncio no período
    // (não o "atribuído" pelo Mercado Livre) — só quando os dois existem.
    const tacos = (investimento !== null && faturamentoRealAnuncio) ? round2((investimento / faturamentoRealAnuncio) * 100) : null;

    const margemAntesDoAds = venda ? (venda.pendentes > 0 ? null : venda.margemContribuicao) : null;
    const margemDepoisDoAds = (margemAntesDoAds !== null && investimento !== null) ? round2(margemAntesDoAds - investimento) : null;
    const margemDepoisDoAdsPct = (margemDepoisDoAds !== null && faturamentoRealAnuncio) ? round2((margemDepoisDoAds / faturamentoRealAnuncio) * 100) : null;

    let status = 'pendente';
    if (margemDepoisDoAds !== null) status = margemDepoisDoAds >= 0 ? 'lucrativo' : 'prejuizo';
    else if (venda && venda.pendentes === 0 && investimento === null) status = 'sem_dado_ads';

    return {
      mlItemId: (venda && venda.mlItemId) || (chave.startsWith('sem-id:') ? null : chave),
      anuncio: (venda && venda.titulo) || (ads && ads.titulo) || null,
      sku: venda ? venda.sku : null,
      campanha: ads ? ads.campanha : null,
      loja: (venda && venda.loja) || (ads && ads.loja) || null,
      contaMlId: (venda && venda.contaMlId) || (ads && ads.contaMlId) || null,
      investimento,
      vendasAtribuidas: faturamentoAtribuido,
      qtdVendasAtribuidas,
      faturamentoAtribuido,
      cliques: ads ? ads.clicks : null,
      impressoes: ads ? ads.prints : null,
      cpc: ads ? ads.cpc : null,
      roas,
      acos,
      tacos,
      quantidadeVendidaReal: venda ? venda.quantidade : 0,
      faturamentoReal: faturamentoRealAnuncio,
      margemAntesDoAds,
      custoAds: investimento,
      margemDepoisDoAds,
      margemDepoisDoAdsPct,
      status,
      rateado: venda ? venda.rateado : false,
      semMetricasAds: !ads,
      semVendaReal: !venda,
    };
  });

  linhas.sort((a, b) => {
    const va = a.faturamentoReal || 0;
    const vb = b.faturamentoReal || 0;
    return vb - va;
  });

  const cards = calcularCards({ diarioMes, hojeStr, linhas, situacaoPorConta });

  return {
    semConta: false,
    lojas: contasTodas.map((c) => ({ id: c.id, nickname: c.nickname })),
    situacaoPorConta,
    linhas,
    cards,
    diario: diarioPeriodo || [],
  };
}

module.exports = { listarAds, calcularCards };
