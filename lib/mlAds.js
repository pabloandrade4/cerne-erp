// Cliente da API de Publicidade (Advertising / Product Ads) do Mercado
// Livre — ativado em 25/08/2026 (tela Ads), corrigido em 25/08/2026 após
// nova leitura da documentação oficial (ver docs/02-decisoes.md e
// docs/04-alteracoes.md, entrada de correção da tela Ads):
// https://developers.mercadolivre.com.br/en_us/product-ads-us-read
//
// Correções feitas nesta revisão (a versão anterior nunca tinha sido
// validada contra a documentação real, só escrita por analogia ao resto
// da API do Mercado Livre — ver docs/05-problemas-conhecidos.md):
// 1) O advertiser_id vai no PATH da URL (`/{advertiser_id}/product_ads/...`),
//    nunca como query string — a versão anterior mandava
//    `?advertiser_id=...`, o que a API real rejeitaria.
// 2) A lista de métricas válidas para o endpoint de ITENS não inclui
//    `ctr`, `cvr` nem `roas` (esses três só existem no endpoint de
//    CAMPANHAS) — a versão anterior pedia os três também em itens, o que
//    faria a API real devolver erro de parâmetro inválido pra toda a
//    chamada. ROAS/ACOS por item continuam calculados aqui (lib/ads.js)
//    a partir de `cost`/`total_amount`, que são reais — isso não é uma
//    estimativa, é aritmética sobre dois números reais.
// 3) Adicionado suporte a `aggregation_type=daily` (mesmo endpoint de
//    itens, devolve investimento/receita por dia, sem quebra por anúncio)
//    para o gráfico diário, e a um endpoint de CAMPANHAS
//    (`/{advertiser_id}/product_ads/campaigns`) só pra resolver o nome da
//    campanha de cada anúncio (campo "campanha" pedido pelo usuário).
//
// Regra do usuário: nunca inventar valor, usar dado real "quando a
// integração/API permitir". Esta API é DIFERENTE da API de pedidos/anúncios
// já usada no resto do projeto — precisa que a conta vendedora tenha uma
// conta de anunciante (advertiser) ativa em Product Ads. A documentação
// pública não deixa explícito se o aplicativo do ERP precisa de algum
// produto/escopo adicional habilitado no painel de desenvolvedores (ver
// docs/05-problemas-conhecidos.md) — por isso TODA chamada aqui é
// protegida: qualquer falha (conta sem acesso a Ads, erro de rede, formato
// inesperado) devolve um motivo estruturado em vez de estourar um erro
// solto, pra quem chamou (lib/ads.js) decidir mostrar "Pendente de
// sincronização" — nunca um número calculado/estimado.
const ml = require('./mercadolivre');

const PRODUCT_ID_PADS = 'PADS'; // Product Ads — os anúncios patrocinados de produto. Display/Brand Ads (DISPLAY/BADS) ficam fora do escopo desta etapa.

// Métricas documentadas para o endpoint de ITENS (aggregation_type=item ou
// daily) — ver comentário acima, item (1). Nomes exatamente como na
// documentação pública, nunca adivinhados.
const METRICS_ITEM = [
  'clicks', 'prints', 'cost', 'cpc', 'acos',
  'direct_amount', 'indirect_amount', 'total_amount',
  'direct_units_quantity', 'indirect_units_quantity', 'units_quantity',
].join(',');

// Métricas pedidas no endpoint de CAMPANHAS — só usado aqui pra resolver
// id→nome; não recalculamos métrica de campanha nenhuma a partir disso
// (o valor de investimento/ROAS/ACOS mostrado na tela é sempre por
// anúncio, fonte única, ver lib/ads.js).
const METRICS_CAMPANHA = 'cost';

function motivoDeErro(err) {
  const status = err && err.status;
  if (status === 401 || status === 403) {
    return { motivo: 'sem_acesso_ads', mensagem: 'Esta conta do Mercado Livre não tem acesso liberado à API de Publicidade (Product Ads) — é preciso ter uma conta de anunciante ativa em Product Ads. Se o erro persistir mesmo com a conta de anunciante ativa, verifique no painel de desenvolvedores do Mercado Livre se o aplicativo do ERP tem o produto "Advertising" habilitado.' };
  }
  if (status === 404) {
    return { motivo: 'sem_anunciante', mensagem: 'Nenhuma conta de anunciante (Product Ads) encontrada para esta conta do Mercado Livre.' };
  }
  if (status === 504) {
    return { motivo: 'timeout', mensagem: 'Tempo esgotado ao consultar a API de Publicidade do Mercado Livre. Tente novamente em instantes.' };
  }
  return { motivo: 'erro_api', mensagem: 'Não foi possível consultar a API de Publicidade do Mercado Livre agora (' + (err && err.message ? err.message : 'erro desconhecido') + ').' };
}

// Lista os IDs de anunciante (advertiser_id) que este token consegue
// enxergar para Product Ads. Uma conta pode, em teoria, ter mais de um
// advertiser_id (multi-site) — usamos o primeiro retornado pro site BR,
// que é o único suportado neste ERP hoje (ver lib/mercadolivre.js).
async function buscarAdvertiserId(accessToken) {
  const data = await ml.apiGet(`/advertising/advertisers?product_id=${PRODUCT_ID_PADS}`, accessToken, { 'Api-Version': '1' });
  const lista = (data && data.advertisers) || (Array.isArray(data) ? data : []);
  if (!lista.length) {
    const err = new Error('Conta sem anunciante de Product Ads.');
    err.status = 404;
    throw err;
  }
  return lista[0].advertiser_id;
}

// Itens (anúncios) com métricas do período, agregação por item (padrão) —
// advertiser_id vai no PATH, nunca em query string.
async function buscarItensComMetricas({ accessToken, advertiserId, desde, ate, limit = 100, offset = 0 }) {
  const qs = new URLSearchParams({
    date_from: desde,
    date_to: ate,
    metrics: METRICS_ITEM,
    limit: String(limit),
    offset: String(offset),
  });
  const data = await ml.apiGet(`/${advertiserId}/product_ads/items?${qs.toString()}`, accessToken, { 'Api-Version': '2' });
  return {
    itens: (data && data.results) || [],
    paging: (data && data.paging) || { total: ((data && data.results) || []).length, limit, offset },
  };
}

// Mesmo endpoint de itens, agregação diária (aggregation_type=daily) — a
// API devolve um total por dia (investimento, receita atribuída etc.) pro
// anunciante inteiro, sem quebra por item/anúncio; é exatamente o dado do
// gráfico "Investimento Ads x Receita atribuída" pedido pelo usuário.
async function buscarMetricasDiarias({ accessToken, advertiserId, desde, ate, limit = 100, offset = 0 }) {
  const qs = new URLSearchParams({
    date_from: desde,
    date_to: ate,
    metrics: METRICS_ITEM,
    aggregation_type: 'daily',
    limit: String(limit),
    offset: String(offset),
  });
  const data = await ml.apiGet(`/${advertiserId}/product_ads/items?${qs.toString()}`, accessToken, { 'Api-Version': '2' });
  return {
    dias: (data && data.results) || [],
    paging: (data && data.paging) || { total: ((data && data.results) || []).length, limit, offset },
  };
}

// Lista de campanhas do anunciante — usada só pra resolver o nome
// ("campanha") de cada anúncio via campaign_id. Se essa chamada falhar,
// não derruba o resto da sincronização (investimento/ROAS/ACOS continuam
// vindo normalmente) — o nome da campanha simplesmente fica indisponível
// pra aquele anúncio, nunca inventado.
async function buscarCampanhas({ accessToken, advertiserId, desde, ate, limit = 100, offset = 0 }) {
  const qs = new URLSearchParams({
    date_from: desde,
    date_to: ate,
    metrics: METRICS_CAMPANHA,
    limit: String(limit),
    offset: String(offset),
  });
  const data = await ml.apiGet(`/${advertiserId}/product_ads/campaigns?${qs.toString()}`, accessToken, { 'Api-Version': '2' });
  return {
    campanhas: (data && data.results) || [],
    paging: (data && data.paging) || { total: ((data && data.results) || []).length, limit, offset },
  };
}

// Pagina um dos três endpoints acima até esgotar o total (com um limite de
// segurança pra nunca entrar em loop se a API parar de paginar direito).
async function paginarTudo(fnPagina, chaveResultado, args) {
  const PAGE_SIZE = 100;
  let offset = 0;
  let total = Infinity;
  const acumulado = [];
  while (offset < total) {
    const pagina = await fnPagina({ ...args, limit: PAGE_SIZE, offset });
    const linhas = pagina[chaveResultado];
    acumulado.push(...linhas);
    total = (pagina.paging && pagina.paging.total) || acumulado.length;
    offset += PAGE_SIZE;
    if (!linhas.length) break;
  }
  return acumulado;
}

// Ponto de entrada ÚNICO usado por lib/ads.js: resolve o advertiser_id UMA
// vez e busca tudo que a tela Ads precisa daquela conta — itens (tabela por
// anúncio), campanhas (nome), série diária do período do filtro (gráfico) e
// série diária mês-atual-até-hoje (cards "Gasto hoje"/"Gasto no mês", que
// são sempre a data real de hoje, independente do período escolhido no
// filtro da tela). Se `periodoDesde/periodoAte` já for a mesma janela de
// `mesDesde/mesAte` (ex.: filtro "Este mês"), a série diária é buscada uma
// vez só e reaproveitada nos dois lugares — nunca uma segunda chamada
// redundante à API.
//
// NUNCA lança erro solto — sempre devolve
// { disponivel: true, advertiserId, itens, campanhas, diarioPeriodo, diarioMes }
// ou { disponivel: false, motivo, mensagem }, pra lib/ads.js decidir a
// situação de sincronização sem precisar interpretar exceções. Se o
// advertiser_id ou os itens (dado essencial) falharem, a conta inteira fica
// indisponível; se só campanhas ou uma das séries diárias falhar, o resto
// continua disponível e só aquele pedaço fica ausente (null/[]).
async function buscarDadosAdsDaConta({ accessToken, periodoDesde, periodoAte, mesDesde, mesAte }) {
  let advertiserId;
  try {
    advertiserId = await buscarAdvertiserId(accessToken);
  } catch (err) {
    return { disponivel: false, ...motivoDeErro(err) };
  }

  let itens;
  try {
    itens = await paginarTudo(buscarItensComMetricas, 'itens', { accessToken, advertiserId, desde: periodoDesde, ate: periodoAte });
  } catch (err) {
    return { disponivel: false, ...motivoDeErro(err) };
  }

  // Best-effort: falha aqui não derruba investimento/ROAS/ACOS, que já
  // vieram na etapa anterior.
  let campanhas = [];
  try {
    campanhas = await paginarTudo(buscarCampanhas, 'campanhas', { accessToken, advertiserId, desde: periodoDesde, ate: periodoAte });
  } catch (e) { /* nome de campanha indisponível — segue sem quebrar o resto */ }

  const mesmaJanela = periodoDesde === mesDesde && periodoAte === mesAte;

  let diarioPeriodo = null;
  try {
    diarioPeriodo = await paginarTudo(buscarMetricasDiarias, 'dias', { accessToken, advertiserId, desde: periodoDesde, ate: periodoAte });
  } catch (e) { /* série diária do período indisponível — gráfico mostra "pendente" */ }

  let diarioMes;
  if (mesmaJanela) {
    diarioMes = diarioPeriodo;
  } else {
    try {
      diarioMes = await paginarTudo(buscarMetricasDiarias, 'dias', { accessToken, advertiserId, desde: mesDesde, ate: mesAte });
    } catch (e) { diarioMes = null; /* cards "Gasto hoje"/"Gasto no mês" ficam pendentes só pra esta conta */ }
  }

  return { disponivel: true, advertiserId, itens, campanhas, diarioPeriodo, diarioMes };
}

module.exports = {
  buscarDadosAdsDaConta,
  buscarAdvertiserId,
  PRODUCT_ID_PADS,
};
