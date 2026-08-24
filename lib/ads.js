// Ads (Product Ads do Mercado Livre) — ativado em 25/08/2026.
//
// Duas fontes bem separadas, NUNCA misturadas numa fórmula nova:
// 1) Métricas de publicidade (investimento, vendas atribuídas, faturamento
//    atribuído, ROAS, ACOS) vêm SEMPRE da API de Advertising do Mercado
//    Livre (lib/mlAds.js), nunca calculadas pelo ERP — se a conta não tiver
//    acesso a Product Ads, ou a API falhar, aparecem como indisponíveis
//    (nunca um número inventado).
// 2) Lucro/margem "antes do Ads" vem da mesma fonte única de sempre
//    (lib/relatorioVendas.js → buscarItensDoPeriodo, que reaproveita
//    lib/resultadoVenda.js) — a margem de contribuição REAL das vendas
//    daquele anúncio no período, idêntica à filosofia de Pedidos/DRE/
//    Financeiro. "Depois do Ads" = essa margem real menos o investimento
//    real em Ads (fonte 1). TACOS = investimento em Ads (fonte 1) dividido
//    pelo faturamento REAL das vendas daquele anúncio no período (fonte 2)
//    — só calculado quando os dois números existem, nunca estimado.
const pool = require('../db/pool');
const { decrypt } = require('./crypto');
const { buscarMetricasDaConta } = require('./mlAds');
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

// Consulta as métricas reais de Ads de todas as contas elegíveis (uma
// conta com erro/sem acesso não impede as demais de mostrar dado real —
// cada uma tem sua própria situação, nunca uma decisão "tudo ou nada").
async function buscarMetricasDeTodasAsContas(contas, { desdeStr, ateStr }) {
  const situacaoPorConta = [];
  const metricasPorAnuncio = new Map();

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

    const resultado = await buscarMetricasDaConta({ accessToken, desde: desdeStr, ate: ateStr });
    if (!resultado.disponivel) {
      situacaoPorConta.push({ contaId: conta.id, loja: conta.nickname, disponivel: false, motivo: resultado.motivo, mensagem: resultado.mensagem });
      continue;
    }
    situacaoPorConta.push({ contaId: conta.id, loja: conta.nickname, disponivel: true });

    resultado.itens.forEach((item) => {
      const metrics = item.metrics_summary || item.metrics || {};
      const investimento = toNum(metrics.cost);
      const faturamentoAtribuido = toNum(metrics.total_amount) !== null
        ? toNum(metrics.total_amount)
        : somarSeAmbos(metrics.direct_amount, metrics.indirect_amount);
      const qtdVendasAtribuidas = toNum(metrics.units_quantity) !== null
        ? toNum(metrics.units_quantity)
        : somarSeAmbos(metrics.direct_units_quantity, metrics.indirect_units_quantity);

      metricasPorAnuncio.set(String(item.item_id || item.id), {
        contaMlId: conta.id,
        loja: conta.nickname,
        titulo: item.title || null,
        investimento,
        faturamentoAtribuido,
        qtdVendasAtribuidas,
        clicks: toNum(metrics.clicks),
        prints: toNum(metrics.prints),
        acosApi: toNum(metrics.acos),
        roasApi: toNum(metrics.roas),
      });
    });
  }

  return { situacaoPorConta, metricasPorAnuncio };
}

// GET principal usado por routes/ads.js — devolve linha por anúncio
// (união do que existe em vendas reais e/ou em métricas de Ads reais, pra
// nunca esconder um anúncio que só aparece de um dos dois lados) e a
// situação de sincronização por loja.
async function listarAds({ empresaId, contaId, desde, ate, desdeStr, ateStr }) {
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
    };
  }

  const contasFiltradas = contaId ? contasTodas.filter((c) => String(c.id) === String(contaId)) : contasTodas;

  const { itens: itensPedidos } = await buscarItensDoPeriodo({ empresaId, desde, ate });
  const itensPedidosFiltrados = contaId ? itensPedidos.filter((it) => String(it.contaMlId) === String(contaId)) : itensPedidos;
  const vendasPorAnuncio = agruparVendasPorAnuncio(itensPedidosFiltrados);

  const { situacaoPorConta, metricasPorAnuncio } = await buscarMetricasDeTodasAsContas(contasFiltradas, { desdeStr, ateStr });

  const chaves = new Set([...vendasPorAnuncio.keys(), ...metricasPorAnuncio.keys()]);
  const linhas = [...chaves].map((chave) => {
    const venda = vendasPorAnuncio.get(chave) || null;
    const ads = metricasPorAnuncio.get(chave) || null;

    const investimento = ads ? ads.investimento : null;
    const faturamentoAtribuido = ads ? ads.faturamentoAtribuido : null;
    const qtdVendasAtribuidas = ads ? ads.qtdVendasAtribuidas : null;

    const roas = ads && ads.roasApi !== null
      ? ads.roasApi
      : (investimento && investimento > 0 && faturamentoAtribuido !== null ? round2(faturamentoAtribuido / investimento) : null);
    const acos = ads && ads.acosApi !== null
      ? ads.acosApi
      : (investimento !== null && faturamentoAtribuido ? round2((investimento / faturamentoAtribuido) * 100) : null);

    const faturamentoRealAnuncio = venda ? venda.faturamento : null;
    // TACOS = investimento em Ads / faturamento REAL do anúncio no período
    // (não o "atribuído" pelo Mercado Livre) — só quando os dois existem.
    const tacos = (investimento !== null && faturamentoRealAnuncio) ? round2((investimento / faturamentoRealAnuncio) * 100) : null;

    const margemAntesDoAds = venda ? (venda.pendentes > 0 ? null : venda.margemContribuicao) : null;
    const margemDepoisDoAds = (margemAntesDoAds !== null && investimento !== null) ? round2(margemAntesDoAds - investimento) : null;

    return {
      mlItemId: (venda && venda.mlItemId) || (chave.startsWith('sem-id:') ? null : chave),
      anuncio: (venda && venda.titulo) || (ads && ads.titulo) || null,
      sku: venda ? venda.sku : null,
      loja: (venda && venda.loja) || (ads && ads.loja) || null,
      contaMlId: (venda && venda.contaMlId) || (ads && ads.contaMlId) || null,
      investimento,
      vendasAtribuidas: faturamentoAtribuido,
      qtdVendasAtribuidas,
      faturamentoAtribuido,
      roas,
      acos,
      tacos,
      quantidadeVendidaReal: venda ? venda.quantidade : 0,
      faturamentoReal: faturamentoRealAnuncio,
      margemAntesDoAds,
      custoAds: investimento,
      margemDepoisDoAds,
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

  return {
    semConta: false,
    lojas: contasTodas.map((c) => ({ id: c.id, nickname: c.nickname })),
    situacaoPorConta,
    linhas,
  };
}

module.exports = { listarAds };
