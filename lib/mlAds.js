// Cliente da API de Publicidade (Advertising / Product Ads) do Mercado
// Livre — ativado em 25/08/2026 (tela Ads). Documentação pública consultada
// em 25/08/2026: https://developers.mercadolivre.com.br/en_us/product-ads-us-read
//
// Regra do usuário: nunca inventar valor, usar dado real "quando a
// integração/API permitir". Esta API é DIFERENTE da API de pedidos/anúncios
// já usada no resto do projeto — precisa que a conta vendedora tenha uma
// conta de anunciante (advertiser) ativa em Product Ads, e o aplicativo do
// ERP precisa ter o produto "Advertising" habilitado no painel de
// desenvolvedores do Mercado Livre. Nada disso é garantido só por ter a
// conta conectada via OAuth (mesmo token usado pra pedidos/anúncios) — por
// isso TODA chamada aqui é protegida: qualquer falha (conta sem acesso a
// Ads, aplicativo sem o produto habilitado, erro de rede, formato
// inesperado) devolve um motivo estruturado em vez de estourar um erro
// solto, pra quem chamou (lib/ads.js) decidir mostrar "Pendente de
// sincronização" — nunca um número calculado/estimado.
const ml = require('./mercadolivre');

const PRODUCT_ID_PADS = 'PADS'; // Product Ads — os anúncios patrocinados de produto. Display/Brand Ads (DISPLAY/BADS) ficam fora do escopo desta etapa.

// Métricas pedidas à API, restritas aos nomes de campo documentados
// publicamente (ver comentário acima) — nunca um nome adivinhado.
const METRICS = [
  'clicks', 'prints', 'cost', 'cpc', 'acos', 'ctr', 'cvr', 'roas',
  'direct_amount', 'indirect_amount', 'total_amount',
  'direct_units_quantity', 'indirect_units_quantity', 'units_quantity',
].join(',');

function motivoDeErro(err) {
  const status = err && err.status;
  if (status === 401 || status === 403) {
    return { motivo: 'sem_acesso_ads', mensagem: 'Esta conta do Mercado Livre não tem acesso liberado à API de Publicidade (Product Ads) — é preciso ter uma conta de anunciante ativa e o aplicativo do ERP habilitado para Advertising no painel de desenvolvedores do Mercado Livre.' };
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

// Métricas por anúncio (item) do anunciante, no período — a mesma
// informação que a tela Ads mostra por linha (investimento, vendas
// atribuídas, ROAS, ACOS etc.), direto da API, nunca recalculada por uma
// fórmula própria do ERP quando o campo já vem pronto.
async function buscarItensComMetricas({ accessToken, advertiserId, desde, ate, limit = 50, offset = 0 }) {
  const qs = new URLSearchParams({
    advertiser_id: advertiserId,
    date_from: desde,
    date_to: ate,
    metrics: METRICS,
    limit: String(limit),
    offset: String(offset),
  });
  const data = await ml.apiGet(`/advertising/product_ads/items?${qs.toString()}`, accessToken, { 'Api-Version': '2' });
  return {
    itens: (data && data.results) || [],
    paging: (data && data.paging) || { total: ((data && data.results) || []).length, limit, offset },
  };
}

// Ponto de entrada único: tenta buscar as métricas reais de Ads de uma
// conta no período. NUNCA lança erro solto — sempre devolve
// { disponivel: true, itens } ou { disponivel: false, motivo, mensagem },
// pra lib/ads.js decidir a situação de sincronização sem precisar
// interpretar exceções.
async function buscarMetricasDaConta({ accessToken, desde, ate }) {
  try {
    const advertiserId = await buscarAdvertiserId(accessToken);
    const PAGE_SIZE = 100;
    let offset = 0;
    let total = Infinity;
    const itens = [];
    while (offset < total) {
      const pagina = await buscarItensComMetricas({ accessToken, advertiserId, desde, ate, limit: PAGE_SIZE, offset });
      itens.push(...pagina.itens);
      total = (pagina.paging && pagina.paging.total) || itens.length;
      offset += PAGE_SIZE;
      if (!pagina.itens.length) break; // segurança: nunca entra em loop se a API parar de paginar sem total correto
    }
    return { disponivel: true, advertiserId, itens };
  } catch (err) {
    return { disponivel: false, ...motivoDeErro(err) };
  }
}

module.exports = { buscarMetricasDaConta, PRODUCT_ID_PADS };
