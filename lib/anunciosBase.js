// Base compartilhada pelas 3 abas de Análise por anúncio, criadas em
// 26/08/2026 (pedido explícito do usuário): "Performance de Anúncios",
// "Visitas e Conversão" e "Margem por Anúncio" (ver lib/performanceAnuncios.js,
// lib/visitasConversao.js, lib/margemAnuncio.js). Reúne aqui só o que é
// idêntico nas três: agrupar vendas reais por anúncio (mesma fonte/fórmula
// de sempre — lib/relatorioVendas.js → lib/resultadoVenda.js, nunca uma
// fórmula nova), buscar o catálogo de anúncios AO VIVO no Mercado Livre
// (mesma fonte da tela Anúncios — lib/mlAnuncios.js) e a data da última
// venda de cada anúncio (para "está há X dias sem vender").
//
// Regra do usuário, válida nas 3 abas: "Não misture lojas ou CNPJs" — por
// isso toda função aqui recebe SEMPRE a lista de contas já filtrada por
// empresa (e por loja, quando o filtro de loja da tela estiver ativo).
const pool = require('../db/pool');
const { round2 } = require('./resultadoVenda');
const { buscarTodosAnunciosDaConta } = require('./mlAnuncios');

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

// Agrupa os ITENS de pedido (já com o resultado financeiro real calculado
// por lib/relatorioVendas.js#buscarItensDoPeriodo) por anúncio (ml_item_id),
// somando tudo que as 3 abas podem precisar: quantidade vendida, quantidade
// de PEDIDOS distintos (diferente de quantidade de unidades — um pedido
// pode ter mais de uma unidade do mesmo anúncio), faturamento, e os
// componentes financeiros usados por "Margem por Anúncio"
// (tarifas/comissões, frete do vendedor, imposto, custo do produto,
// margem de contribuição) — os mesmos nomes/fórmula de sempre, nunca um
// cálculo novo.
function agruparVendasDetalhado(itensPedidos) {
  const porAnuncio = new Map();
  (itensPedidos || []).forEach((it) => {
    const chave = it.mlItemId || `sem-id:${it.sku || 's-sku'}:${it.contaMlId}`;
    if (!porAnuncio.has(chave)) {
      porAnuncio.set(chave, {
        mlItemId: it.mlItemId || null,
        sku: it.sku || null,
        titulo: it.titulo || null,
        loja: it.loja || null,
        contaMlId: it.contaMlId || null,
        quantidade: 0,
        pedidosDistintos: new Set(),
        faturamento: 0,
        tarifas: 0,
        temTarifas: true,
        freteVendedor: 0,
        temFrete: true,
        imposto: 0,
        temImposto: true,
        custoProduto: 0,
        temCusto: true,
        margemContribuicao: 0,
        pendentes: 0,
        rateado: false,
      });
    }
    const acc = porAnuncio.get(chave);
    acc.quantidade += it.quantidade || 0;
    acc.pedidosDistintos.add(it.pedidoId);
    if (it.valorTotalItem !== null) acc.faturamento = round2(acc.faturamento + it.valorTotalItem);
    if (it.tarifas !== null) acc.tarifas = round2(acc.tarifas + it.tarifas); else acc.temTarifas = false;
    if (it.freteVendedor !== null) acc.freteVendedor = round2(acc.freteVendedor + it.freteVendedor); else acc.temFrete = false;
    if (it.imposto !== null) acc.imposto = round2(acc.imposto + it.imposto); else acc.temImposto = false;
    if (it.custoProduto !== null) acc.custoProduto = round2(acc.custoProduto + it.custoProduto); else acc.temCusto = false;
    if (it.calculoCompleto) acc.margemContribuicao = round2(acc.margemContribuicao + it.margemContribuicao);
    else acc.pendentes += 1;
    if (it.rateado) acc.rateado = true;
    if (!acc.titulo && it.titulo) acc.titulo = it.titulo;
    if (!acc.sku && it.sku) acc.sku = it.sku;
  });

  // Converte pedidosDistintos (Set) em contagem e "zera" os componentes que
  // nunca tiveram um valor completo (temX=false) para null, em vez de 0 —
  // 0 seria um número inventado quando na verdade é dado faltando.
  const resultado = new Map();
  porAnuncio.forEach((acc, chave) => {
    resultado.set(chave, {
      mlItemId: acc.mlItemId,
      sku: acc.sku,
      titulo: acc.titulo,
      loja: acc.loja,
      contaMlId: acc.contaMlId,
      quantidade: acc.quantidade,
      quantidadePedidos: acc.pedidosDistintos.size,
      faturamento: acc.faturamento,
      tarifas: acc.temTarifas ? acc.tarifas : null,
      freteVendedor: acc.temFrete ? acc.freteVendedor : null,
      imposto: acc.temImposto ? acc.imposto : null,
      custoProduto: acc.temCusto ? acc.custoProduto : null,
      margemContribuicao: acc.pendentes === 0 ? acc.margemContribuicao : null,
      pendentes: acc.pendentes,
      margemIncompleta: acc.pendentes > 0,
      rateado: acc.rateado,
    });
  });
  return resultado;
}

// Busca o catálogo de anúncios AO VIVO no Mercado Livre para um conjunto de
// contas (mesma fonte da tela Anúncios — lib/mlAnuncios.js), já separando
// por situação de sincronização (mesmo padrão de lib/ads.js#buscarSituacaoPorConta):
// contas com erro/desconectadas nunca são consultadas ao vivo — aparecem em
// `situacaoPorConta` com o motivo real, nunca com dado inventado.
async function buscarAnunciosVivosPorConta(contasFiltradas) {
  const porItemId = new Map();
  const situacaoPorConta = [];

  for (const conta of contasFiltradas) {
    if (conta.status !== 'ativa') {
      situacaoPorConta.push({
        contaId: conta.id, loja: conta.nickname, disponivel: false,
        motivo: 'conta_com_erro',
        mensagem: 'A conexão desta conta com o Mercado Livre está com erro ou desconectada. Reconecte em Marketplaces para ver preço/status/estoque atuais dos anúncios desta loja.',
      });
      continue;
    }
    try {
      const { itens, truncado } = await buscarTodosAnunciosDaConta(conta.id);
      itens.forEach((item) => porItemId.set(String(item.id), item));
      situacaoPorConta.push({ contaId: conta.id, loja: conta.nickname, disponivel: true, truncado: !!truncado, totalAnuncios: itens.length });
    } catch (err) {
      situacaoPorConta.push({
        contaId: conta.id, loja: conta.nickname, disponivel: false,
        motivo: 'erro_api',
        mensagem: 'Não foi possível buscar o catálogo de anúncios desta loja agora (' + (err.message || 'erro na API do Mercado Livre') + ').',
      });
    }
  }

  return { porItemId, situacaoPorConta };
}

// Data da última venda real (não cancelada) de cada anúncio, até o fim do
// período selecionado (`ateStr`, YYYY-MM-DD) — usada para "está há X dias
// sem vender". Deliberadamente NÃO limitada ao início do período: um
// anúncio sem venda no período de 7 dias pode ter vendido há 40 dias, e é
// exatamente essa distância real que a tela precisa mostrar (nunca
// inventada — é uma consulta real ao histórico completo de pedidos
// sincronizados, sem limite de janela).
async function buscarUltimaVendaPorAnuncio({ empresaId, contaIds, ateStr }) {
  const porItemId = new Map();
  if (!contaIds || !contaIds.length) return porItemId;
  const { rows } = await pool.query(
    `SELECT pi.ml_item_id, MAX(COALESCE(p.data_fechamento, p.data_criacao)) AS ultima_venda
       FROM ml_pedido_itens pi
       JOIN ml_pedidos p ON p.id = pi.pedido_id
      WHERE p.conta_ml_id = ANY($1)
        AND p.status <> 'cancelled'
        AND pi.ml_item_id IS NOT NULL
        AND COALESCE(p.data_fechamento, p.data_criacao) <= ($2::date + interval '1 day')
      GROUP BY pi.ml_item_id`,
    [contaIds, ateStr]
  );
  rows.forEach((r) => { if (r.ultima_venda) porItemId.set(String(r.ml_item_id), new Date(r.ultima_venda)); });
  return porItemId;
}

// Nome do produto cadastrado (tela Produtos) para um conjunto de SKUs de uma
// empresa — "produto" (cadastro interno) é diferente de "anúncio" (título
// do anúncio no Mercado Livre); quando o SKU não está cadastrado em
// Produtos, fica null (nunca inventa um nome).
async function buscarNomesProdutoPorSku(empresaId, skus) {
  const unicos = [...new Set((skus || []).filter(Boolean))];
  const porSku = new Map();
  if (!unicos.length) return porSku;
  const { rows } = await pool.query(
    `SELECT sku, nome FROM produtos WHERE empresa_id = $1 AND sku = ANY($2::text[])`,
    [empresaId, unicos]
  );
  rows.forEach((r) => porSku.set(r.sku, r.nome));
  return porSku;
}

// Resolve as contas da empresa já filtradas por loja (contaId), no mesmo
// padrão usado em Ads/Anúncios — nunca mistura empresa/loja diferentes da
// pedida.
async function buscarContasFiltradas({ empresaId, contaId }) {
  const { rows: contasTodas } = await pool.query(
    'SELECT * FROM ml_contas WHERE empresa_id = $1 ORDER BY nickname',
    [empresaId]
  );
  const contasFiltradas = contaId ? contasTodas.filter((c) => String(c.id) === String(contaId)) : contasTodas;
  return { contasTodas, contasFiltradas };
}

function diasEntre(dataA, dataB) {
  const MS_DIA = 24 * 60 * 60 * 1000;
  return Math.floor((dataB.getTime() - dataA.getTime()) / MS_DIA);
}

// Crescimento/queda percentual entre dois valores numéricos — mesma regra
// nas 3 abas (unidades vendidas, faturamento, visitas): sem base de
// comparação (anterior = 0) não existe percentual (divisão por zero não é
// "infinito", é indefinido) — nesse caso `percentual` fica null e `novo`
// fica true quando havia valor no período atual mas nenhum no anterior, pra
// tela mostrar "Novo" em vez de inventar um percentual.
function calcularCrescimento(atual, anterior) {
  const a = toNum(atual) || 0;
  const b = toNum(anterior) || 0;
  if (b > 0) return { percentual: round2(((a - b) / b) * 100), novo: false };
  if (a > 0) return { percentual: null, novo: true };
  return { percentual: null, novo: false };
}

// Resolve a IDENTIDADE do anúncio (item_id, capa/foto, título, SKU, loja) a
// partir das duas fontes possíveis — venda agrupada (agruparVendasDetalhado)
// e catálogo ao vivo (buscarAnunciosVivosPorConta) — SEMPRE da mesma forma,
// nesta única função. Criada em 26/08/2026 (pedido explícito do usuário:
// "As três páginas... devem usar o mesmo item_id, capa/foto, SKU, loja,
// pedidos, período. Não quero cada página construindo uma versão diferente
// do mesmo anúncio. Centralize os serviços/consultas no backend"). Antes
// desta função, cada uma das 3 abas montava esse merge com sua própria
// expressão `(venda && venda.titulo) || (vivo && vivo.titulo) || null`
// repetida — agora as 3 chamam esta função, então uma mudança na regra de
// prioridade (ex: preferir o título AO VIVO em vez do título da venda) só
// precisa ser feita uma vez.
//
// A capa/foto só existe na fonte "vivo" (dado real do próprio anúncio no
// Mercado Livre) — nunca é inventada a partir da venda. Um anúncio que
// vendeu no período mas não está mais no catálogo ao vivo (encerrado há
// muito tempo, por exemplo) fica sem imagem — o front-end mostra um
// placeholder discreto, nunca uma imagem de outro anúncio.
function resolverIdentidade({ mlItemId, venda, vivo }) {
  return {
    mlItemId: mlItemId || (venda && venda.mlItemId) || (vivo && String(vivo.id)) || null,
    imagemUrl: (vivo && vivo.imagemUrl) || null,
    anuncio: (vivo && vivo.titulo) || (venda && venda.titulo) || null,
    sku: (venda && venda.sku) || (vivo && vivo.sku) || null,
    loja: (venda && venda.loja) || (vivo && vivo.loja) || null,
    contaMlId: (venda && venda.contaMlId) || (vivo && vivo.contaId) || null,
    status: vivo ? vivo.status : null,
    precoAtual: vivo ? vivo.preco : null,
  };
}

module.exports = {
  agruparVendasDetalhado,
  buscarAnunciosVivosPorConta,
  buscarUltimaVendaPorAnuncio,
  buscarNomesProdutoPorSku,
  buscarContasFiltradas,
  diasEntre,
  calcularCrescimento,
  resolverIdentidade,
};
