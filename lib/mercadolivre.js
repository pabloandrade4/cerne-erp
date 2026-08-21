// Cliente mínimo da API do Mercado Livre: troca/renovação de token e
// chamadas GET autenticadas. Usa apenas endpoints reais e documentados —
// nenhum dado é calculado ou estimado aqui, só repassado como a API retornou.
const API_BASE = 'https://api.mercadolibre.com';

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
  const res = await fetch(API_BASE + path, {
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

async function apiGet(path, accessToken) {
  const res = await fetch(API_BASE + path, {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
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
