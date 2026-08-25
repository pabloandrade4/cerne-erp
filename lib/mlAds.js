// Cliente da API de Publicidade (Advertising / Product Ads) do Mercado
// Livre — ativado em 25/08/2026 (tela Ads), CORRIGIDO EM 25/08/2026 após
// nova leitura da documentação oficial e ATUAL do Mercado Livre (pedido
// explícito do usuário — ver docs/02-decisoes.md e docs/04-alteracoes.md,
// entrada "Ads: diagnóstico real + endpoints atuais"):
//   https://global-selling.mercadolibre.com/devsite/new-product-ads
//   https://global-selling.mercadolibre.com/devsite/mercado-ads
// (a documentação em developers.mercadolivre.com.br/en_us/product-ads-us-read
// continua existindo mas não é a única — a Mercado Livre unificou a
// documentação de Product Ads na "Global Selling devsite"; é a MESMA API
// real, api.mercadolibre.com, não uma API separada para contas de venda
// internacional — Mercado Ads em si "está disponível apenas no Brasil,
// México e Chile", sem distinção documentada entre conta doméstica e
// cross-border).
//
// Correções feitas nesta revisão (25/08/2026):
// 1) A checagem de anunciante (`/advertising/advertisers`) exige também o
//    parâmetro `user_id` — a versão anterior só mandava `product_id=PADS`.
//    Sem `user_id`, a causa mais provável de "nenhum anunciante encontrado"
//    mesmo numa conta que já anuncia é exatamente esse parâmetro faltando.
// 2) Os endpoints de campanhas e anúncios usados antes
//    (`/{advertiser_id}/product_ads/items` e
//    `/{advertiser_id}/product_ads/campaigns`) são o formato ANTIGO. A
//    documentação atual exige a estrutura nova, com o site do anunciante no
//    path e (para campanhas) o sufixo `/search`:
//      GET /marketplace/advertising/{site_id}/advertisers/{advertiser_id}/product_ads/ads
//      GET /marketplace/advertising/{site_id}/advertisers/{advertiser_id}/product_ads/campaigns/search
//    ("From now, the request to .../product_ads/campaigns must include
//    /search" — aviso de descontinuação do formato antigo).
// 3) A lista de métricas do endpoint de anúncios agora INCLUI `ctr`, `cvr`
//    e `roas` — a versão anterior excluía as três achando que só existiam
//    no endpoint de campanhas; o exemplo oficial atual as lista também para
//    anúncios/itens. ROAS/ACOS por anúncio continuam também calculados em
//    lib/ads.js a partir de `cost`/`total_amount` (dois números reais) — a
//    versão vinda da API é só um valor adicional, nunca substitui o
//    cálculo quando ausente.
// 4) NÃO existe "Ad Group" na API do Mercado Livre — o fluxo real é
//    anunciante → campanha → anúncio (item), sem camada intermediária.
// 5) Diagnóstico real (pedido explícito do usuário — nunca mais um "nenhum
//    anunciante encontrado" genérico): toda falha aqui carrega o status
//    HTTP real, o corpo da resposta do Mercado Livre e o endpoint/parâmetros
//    usados (ver `motivoDeErro`/`detalheApi` abaixo) — quem chamar
//    (lib/ads.js) grava esse detalhe em ads_contas.detalhe_api pra quem for
//    investigar, e mostra a mensagem (já traduzida, com a causa real citada)
//    pro usuário na tela.
//
// Regra do usuário: nunca inventar valor, usar dado real "quando a
// integração/API permitir". Esta API é DIFERENTE da API de pedidos/anúncios
// já usada no resto do projeto — precisa que a conta vendedora tenha uma
// conta de anunciante (advertiser) ativa em Product Ads. Por isso TODA
// chamada aqui é protegida: qualquer falha (conta sem acesso a Ads, erro de
// rede, formato inesperado) devolve um motivo estruturado em vez de
// estourar um erro solto, pra quem chamou decidir mostrar "Pendente de
// sincronização" — nunca um número calculado/estimado.
const ml = require('./mercadolivre');

const PRODUCT_ID_PADS = 'PADS'; // Product Ads — os anúncios patrocinados de produto. Display/Brand Ads (DISPLAY/BADS) ficam fora do escopo desta etapa.

// Métricas documentadas para o endpoint de anúncios (product_ads/ads) —
// nomes exatamente como na documentação pública atual, nunca adivinhados
// (ver correção (3) acima).
const METRICS_ADS = [
  'clicks', 'prints', 'ctr', 'cost', 'cpc', 'acos', 'cvr', 'roas',
  'direct_amount', 'indirect_amount', 'total_amount',
  'direct_units_quantity', 'indirect_units_quantity', 'units_quantity',
].join(',');

// Métricas pedidas no endpoint de CAMPANHAS — só usado aqui pra resolver
// id→nome; não recalculamos métrica de campanha nenhuma a partir disso
// (o valor de investimento/ROAS/ACOS mostrado na tela é sempre por
// anúncio, fonte única, ver lib/ads.js).
const METRICS_CAMPANHA = 'cost';

// Extrai uma mensagem legível do corpo de erro real da API (formato comum
// do Mercado Livre: { message, error, cause: [{ code, description }] }) —
// nunca inventa texto, só repassa o que a API respondeu.
function extrairMensagemApi(err) {
  const d = err && err.data;
  if (!d) return null;
  const partes = [];
  if (d.message) partes.push(String(d.message));
  else if (d.error) partes.push(String(d.error));
  if (Array.isArray(d.cause)) {
    d.cause.forEach((c) => {
      const desc = c && (c.description || c.message);
      if (desc) partes.push(String(desc));
    });
  }
  return partes.length ? partes.join(' — ') : null;
}

// Monta o motivo estruturado + a mensagem (com a causa REAL citada, nunca
// um texto genérico solto) + o detalhe técnico completo pra log/auditoria —
// pedido explícito do usuário (Passo 1): "Se o Mercado Livre retornar erro,
// a interface/log deve mostrar o status e a causa."
function motivoDeErro(err, contexto) {
  const status = err && err.status;
  const mensagemApi = extrairMensagemApi(err);
  const citarApi = mensagemApi ? ` Resposta do Mercado Livre: "${mensagemApi}".` : '';
  const detalheApi = {
    status: status || null,
    endpoint: (contexto && contexto.endpoint) || (err && err.contexto && err.contexto.endpoint) || null,
    parametros: (contexto && contexto.parametros) || (err && err.contexto && err.contexto.parametros) || null,
    corpoResposta: (err && err.data) || null,
    mensagemOriginal: (err && err.message) || null,
  };

  if (status === 401 || status === 403) {
    return {
      motivo: 'sem_acesso_ads',
      mensagem: `Esta conta do Mercado Livre não tem acesso liberado à API de Publicidade (Product Ads).${citarApi} Verifique no painel de desenvolvedores do Mercado Livre se o aplicativo do ERP tem o produto "Advertising" habilitado para esta conta.`,
      detalheApi,
    };
  }
  if (status === 404) {
    return {
      motivo: 'sem_anunciante',
      mensagem: `Nenhuma conta de anunciante (Product Ads) encontrada para esta conta do Mercado Livre.${citarApi} Isso normalmente significa que o vendedor ainda não ativou Product Ads (Mercado Livre → Anúncios → Publicidade). Se esta conta já anuncia, verifique também se o app do ERP tem o produto "Advertising" habilitado no painel de desenvolvedores do Mercado Livre.`,
      detalheApi,
    };
  }
  if (status === 400) {
    return {
      motivo: 'parametro_invalido',
      mensagem: `O Mercado Livre rejeitou a chamada à API de Publicidade por parâmetro inválido (HTTP 400).${citarApi} Provável mudança na API — ver detalhe técnico no log do servidor.`,
      detalheApi,
    };
  }
  if (status === 504) {
    return { motivo: 'timeout', mensagem: 'Tempo esgotado ao consultar a API de Publicidade do Mercado Livre. Tente novamente em instantes.', detalheApi };
  }
  return {
    motivo: 'erro_api',
    mensagem: `Não foi possível consultar a API de Publicidade do Mercado Livre agora${status ? ` (HTTP ${status})` : ''}.${citarApi || ` (${(err && err.message) || 'erro desconhecido'})`}`,
    detalheApi,
  };
}

// Verifica se esta conta tem anunciante de Product Ads e devolve
// advertiser_id + site_id (quando a API os retorna) — `user_id` é
// obrigatório na documentação atual (ver correção (1) acima).
async function buscarAdvertiserId({ accessToken, mlUserId }) {
  const qs = new URLSearchParams({ product_id: PRODUCT_ID_PADS });
  if (mlUserId) qs.set('user_id', String(mlUserId));
  const endpoint = `/advertising/advertisers?${qs.toString()}`;
  const parametros = { product_id: PRODUCT_ID_PADS, user_id: mlUserId || null };

  let data;
  try {
    data = await ml.apiGet(endpoint, accessToken, { 'Api-Version': '1' });
  } catch (err) {
    err.contexto = { endpoint, parametros };
    throw err;
  }

  const lista = (data && data.advertisers) || (Array.isArray(data) ? data : []);
  if (!lista.length) {
    const err = new Error('A API respondeu sem erro, mas a lista de anunciantes de Product Ads veio vazia para esta conta.');
    err.status = 404;
    err.data = data;
    err.contexto = { endpoint, parametros };
    throw err;
  }
  const primeiro = lista[0];
  return {
    advertiserId: primeiro.advertiser_id,
    siteId: primeiro.site_id || null,
    advertiserName: primeiro.advertiser_name || null,
  };
}

// Anúncios (itens) com métricas do período — `aggregationType` opcional:
// omitido = total por anúncio no intervalo pedido (usado pra cada janela de
// período, ver lib/adsScheduler.js); 'daily' = total por dia da conta
// inteira (usado pro gráfico).
async function buscarAdsComMetricas({ accessToken, siteId, advertiserId, desde, ate, aggregationType, limit = 100, offset = 0 }) {
  const qs = new URLSearchParams({
    date_from: desde,
    date_to: ate,
    metrics: METRICS_ADS,
    limit: String(limit),
    offset: String(offset),
  });
  if (aggregationType) qs.set('aggregation_type', aggregationType);
  const endpoint = `/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads/ads?${qs.toString()}`;
  try {
    const data = await ml.apiGet(endpoint, accessToken, { 'Api-Version': '2' });
    return {
      itens: (data && data.results) || (Array.isArray(data) ? data : []),
      paging: (data && data.paging) || { total: ((data && data.results) || []).length, limit, offset },
    };
  } catch (err) {
    err.contexto = { endpoint, parametros: { date_from: desde, date_to: ate, aggregation_type: aggregationType || null } };
    throw err;
  }
}

function buscarItensComMetricas(args) {
  return buscarAdsComMetricas(args);
}

function buscarMetricasDiarias(args) {
  return buscarAdsComMetricas({ ...args, aggregationType: 'daily' }).then((r) => ({ dias: r.itens, paging: r.paging }));
}

// Lista de campanhas do anunciante — usada só pra resolver o nome
// ("campanha") de cada anúncio via campaign_id. Se essa chamada falhar,
// não derruba o resto da sincronização (investimento/ROAS/ACOS continuam
// vindo normalmente) — o nome da campanha simplesmente fica indisponível
// pra aquele anúncio, nunca inventado. Endpoint com sufixo `/search`
// obrigatório (ver correção (2) acima).
async function buscarCampanhas({ accessToken, siteId, advertiserId, desde, ate, limit = 100, offset = 0 }) {
  const qs = new URLSearchParams({
    date_from: desde,
    date_to: ate,
    metrics: METRICS_CAMPANHA,
    limit: String(limit),
    offset: String(offset),
  });
  const endpoint = `/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search?${qs.toString()}`;
  try {
    const data = await ml.apiGet(endpoint, accessToken, { 'Api-Version': '2' });
    return {
      campanhas: (data && data.results) || (Array.isArray(data) ? data : []),
      paging: (data && data.paging) || { total: ((data && data.results) || []).length, limit, offset },
    };
  } catch (err) {
    err.contexto = { endpoint, parametros: { date_from: desde, date_to: ate } };
    throw err;
  }
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

// Ponto de entrada ÚNICO usado pela sincronização (lib/ads.js): resolve o
// advertiser_id (e confirma o site_id) UMA vez, depois busca os anúncios do
// intervalo `periodoDesde..periodoAte` pedido, mais campanhas (nome) e,
// quando `mesDesde/mesAte` for informado e diferente do período, a série
// diária desse intervalo (usada pro gráfico e pelos cards de topo).
//
// NUNCA lança erro solto — sempre devolve
// { disponivel: true, advertiserId, siteId, itens, campanhas, diario? }
// ou { disponivel: false, motivo, mensagem, detalheApi, advertiserId?, siteId? },
// pra quem chamou decidir a situação de sincronização sem precisar
// interpretar exceções.
async function buscarDadosAdsDaConta({ accessToken, mlUserId, siteId, desde, ate, comSerieDiaria }) {
  let advertiserInfo;
  try {
    advertiserInfo = await buscarAdvertiserId({ accessToken, mlUserId });
  } catch (err) {
    return { disponivel: false, ...motivoDeErro(err) };
  }

  const advertiserId = advertiserInfo.advertiserId;
  const siteIdResolvido = advertiserInfo.siteId || siteId;
  if (!siteIdResolvido) {
    return {
      disponivel: false,
      advertiserId,
      motivo: 'sem_site_id',
      mensagem: 'O Mercado Livre confirmou um anunciante de Product Ads, mas não informou o site (país) do anunciante, e a conta também não tem site_id cadastrado no ERP — não é possível montar a URL da API sem isso.',
      detalheApi: { status: null, endpoint: '/advertising/advertisers', parametros: null, corpoResposta: null, mensagemOriginal: null },
    };
  }

  let itens;
  try {
    itens = await paginarTudo(buscarItensComMetricas, 'itens', { accessToken, siteId: siteIdResolvido, advertiserId, desde, ate });
  } catch (err) {
    return { disponivel: false, advertiserId, siteId: siteIdResolvido, ...motivoDeErro(err) };
  }

  // Best-effort: falha aqui não derruba investimento/ROAS/ACOS, que já
  // vieram na etapa anterior.
  let campanhas = [];
  try {
    campanhas = await paginarTudo(buscarCampanhas, 'campanhas', { accessToken, siteId: siteIdResolvido, advertiserId, desde, ate });
  } catch (e) { /* nome de campanha indisponível — segue sem quebrar o resto */ }

  let diario = null;
  if (comSerieDiaria) {
    try {
      diario = await paginarTudo(buscarMetricasDiarias, 'dias', { accessToken, siteId: siteIdResolvido, advertiserId, desde, ate });
    } catch (e) { /* série diária indisponível — gráfico mostra "pendente" pra este ciclo */ }
  }

  return { disponivel: true, advertiserId, siteId: siteIdResolvido, itens, campanhas, diario };
}

module.exports = {
  buscarDadosAdsDaConta,
  buscarAdvertiserId,
  motivoDeErro,
  PRODUCT_ID_PADS,
};
