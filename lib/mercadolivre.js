// Cliente mínimo da API do Mercado Livre: troca/renovação de token e
// chamadas GET autenticadas. Usa apenas endpoints reais e documentados —
// nenhum dado é calculado ou estimado aqui, só repassado como a API retornou.
const API_BASE = 'https://api.mercadolibre.com';

// Timeout por chamada HTTP ao Mercado Livre. Sem isso, uma conexão que trava
// (rate limit, instabilidade de rede) prende a sincronização inteira para
// sempre, já que o Node não aplica timeout nenhum por padrão no fetch().
const REQUEST_TIMEOUT_MS = 20000;

async function fetchComTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`Tempo limite (${REQUEST_TIMEOUT_MS / 1000}s) excedido ao chamar a API do Mercado Livre.`);
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Domínio de autorização (login/consentimento) por site. Só Brasil (MLB) é
// usado nesta etapa — os demais ficam prontos para quando o ERP suportar
// outros países.
const AUTH_DOMAIN_BY_SITE = {
  MLB: 'https://auth.mercadolivre.com.br',
};

function buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge, site = 'MLB' }) {
  const domain = AUTH_DOMAIN_BY_SITE[site] || AUTH_DOMAIN_BY_SITE.MLB;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${domain}/authorization?${params.toString()}`;
}

async function postForm(path, form) {
  const res = await fetchComTimeout(API_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error_description || data.error)) || 'Erro na API do Mercado Livre.');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function exchangeCodeForToken({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  return postForm('/oauth/token', form);
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  return postForm('/oauth/token', form);
}

// `extraHeaders` é opcional e aditivo (ex: `Api-Version` exigido pela API
// de Advertising — ver lib/mlAds.js) — chamadas existentes que não passam
// esse terceiro argumento continuam funcionando exatamente como antes.
async function apiGet(path, accessToken, extraHeaders) {
  const res = await fetchComTimeout(API_BASE + path, {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json', ...(extraHeaders || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Erro na API do Mercado Livre (${path}).`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// PRIMEIRA função de ESCRITA deste arquivo (19/09/2026, pedido explícito do
// usuário: "eu vou aprovar, aí vai fazer" — quer que a IA de Ads já execute
// de verdade no Mercado Livre depois que ele aprovar uma sugestão, não só
// anote a aprovação no banco como fazia até aqui — ver lib/mlAds.js#
// atualizarCampanha e lib/ia/adsExecutor.js). Mesmo padrão de erro do
// apiGet acima (nunca lança silenciosamente, sempre carrega status HTTP +
// corpo da resposta real do Mercado Livre em err.data). `body` já deve vir
// serializado (JSON.stringify) de quem chamar.
async function apiPut(path, accessToken, body, extraHeaders) {
  const res = await fetchComTimeout(API_BASE + path, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(extraHeaders || {}),
    },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Erro na API do Mercado Livre (${path}).`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ============================================================================
// SAC (Perguntas, Mensagens pós-venda, Reclamações) — 14/09/2026, agente
// "SAC Mercado Livre" (ver lib/ia/sacMercadoLivre.js). Só LEITURA — nenhuma
// função de resposta/envio aqui (mesma regra do resto deste arquivo: 100%
// somente-leitura até hoje). PRIMEIRA sincronização deste projeto contra
// estas 3 APIs — ainda não testada contra o Mercado Livre de verdade; os
// nomes de endpoint/campo seguem a documentação pública (developers.
// mercadolivre.com.br), mas se a API rejeitar algum parâmetro o erro
// aparece no resultado da sincronização (lib/ia/sacMercadoLivre.js sempre
// isola cada fonte com try/catch) — nunca falha silenciosamente nem inventa
// dado no lugar.

// GET /questions/search?seller_id=...&status=...&sort_fields=date_created&sort_types=DESC
// Perguntas feitas no anúncio (antes da compra). `status` opcional
// (UNANSWERED | ANSWERED | ...) — lib/ia/sacMercadoLivre.js decide o que
// pedir.
async function buscarPerguntas({ accessToken, sellerId, status, limit = 50, offset = 0 }) {
  const params = new URLSearchParams({
    seller_id: String(sellerId),
    sort_fields: 'date_created',
    sort_types: 'DESC',
    limit: String(limit),
    offset: String(offset),
  });
  if (status) params.set('status', status);
  return apiGet(`/questions/search?${params.toString()}`, accessToken);
}

// GET /messages/packs/{pack_id}/sellers/{sellerId}?tag=post_sale
// Mensagens pós-venda de um pedido (pack_id) — o Mercado Livre agrupa a
// conversa inteira do pedido aqui. Só leitura: nunca chama o POST desse
// mesmo endpoint (isso seria "enviar", proibido nesta fase).
async function buscarMensagensPosVenda({ accessToken, packId, sellerId }) {
  return apiGet(`/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`, accessToken);
}

// GET /post-purchase/v1/claims/search?seller_id=...
// Reclamações/mediações abertas contra o vendedor (inclui devoluções
// formais, que no Mercado Livre nascem como um tipo de claim).
async function buscarReclamacoes({ accessToken, sellerId, limit = 50, offset = 0 }) {
  const params = new URLSearchParams({ seller_id: String(sellerId), limit: String(limit), offset: String(offset) });
  return apiGet(`/post-purchase/v1/claims/search?${params.toString()}`, accessToken);
}

// GET /post-purchase/v1/claims/{claimId}/messages — histórico de mensagens
// de uma reclamação específica (usado pra dar mais contexto pra IA sugerir
// a resposta).
async function buscarMensagensReclamacao({ accessToken, claimId }) {
  return apiGet(`/post-purchase/v1/claims/${claimId}/messages`, accessToken);
}

module.exports = {
  buildAuthorizationUrl, exchangeCodeForToken, refreshAccessToken, apiGet, apiPut,
  buscarPerguntas, buscarMensagensPosVenda, buscarReclamacoes, buscarMensagensReclamacao,
};
