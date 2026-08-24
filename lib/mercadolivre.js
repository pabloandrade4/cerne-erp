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

module.exports = { buildAuthorizationUrl, exchangeCodeForToken, refreshAccessToken, apiGet };
