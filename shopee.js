// Cliente mínimo da Shopee Open Platform API v2 (open.shopee.com) — só o que
// esta etapa precisa: autorizar uma loja (OAuth), trocar/renovar token e
// consultar os dados básicos da loja autorizada. Não implementa pedidos,
// estoque, Ads, Full nem financeiro da Shopee (fora do pedido desta etapa).
//
// Diferente do Mercado Livre (client_secret enviado direto no corpo da
// requisição), a Shopee Open Platform v2 assina CADA chamada: um parâmetro
// `sign` (HMAC-SHA256, chave = partner_key) vai na query string de toda
// requisição, calculado sobre uma "base string" que nunca inclui o
// partner_key em si (só o usa como chave de assinatura) — o partner_key
// nunca trafega pela rede.
//
// A Shopee documenta 3 "tipos" de chamada, cada um com uma base string
// diferente (fonte: documentação oficial em open.shopee.com/documents,
// cruzada com múltiplos guias de integração de terceiros nesta etapa — ver
// docs/05-problemas-conhecidos.md sobre a limitação de não ter sido possível
// abrir open.shopee.com direto neste ambiente para conferir byte a byte):
//   - "Public" (sem loja autorizada ainda): partner_id + path + timestamp
//     — usada pela própria URL de autorização (shop/auth_partner) e pelas
//     trocas de token (auth/token/get, auth/access_token/get), porque
//     nesses três casos ainda não existe (ou não é necessário) um
//     access_token/shop_id específico.
//   - "Shop" (loja já autorizada): partner_id + path + timestamp +
//     access_token + shop_id — usada por qualquer chamada que opera sobre
//     uma loja específica (ex.: shop/get_shop_info).
// Se a Shopee responder "wrong sign" numa chamada ao vivo, o primeiro lugar
// a conferir é `gerarAssinatura` abaixo, testando primeiro contra o
// ambiente de testes (partner.test-stable.shopeemobile.com), como a própria
// Shopee recomenda.
const crypto = require('crypto');

// Host configurável (SHOPEE_HOST) para permitir apontar para o ambiente de
// testes da Shopee (partner.test-stable.shopeemobile.com) sem mudar código
// — mesma ideia de configurabilidade já usada em IA_PROVEDOR/IA_MODELO.
const HOST_PADRAO = 'partner.shopeemobile.com';
function getHost() {
  return process.env.SHOPEE_HOST || HOST_PADRAO;
}

const REQUEST_TIMEOUT_MS = 20000;

async function fetchComTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`Tempo limite (${REQUEST_TIMEOUT_MS / 1000}s) excedido ao chamar a API da Shopee.`);
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

// timestamp em SEGUNDOS (não milissegundos) — exigido pela Shopee.
function timestampAtual() {
  return Math.floor(Date.now() / 1000);
}

function gerarAssinatura({ partnerKey, baseString }) {
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

// tipo: 'public' (partner_id+path+timestamp) ou 'shop' (+ access_token + shop_id)
function assinar({ partnerId, partnerKey, path, timestamp, tipo = 'public', accessToken, shopId }) {
  let baseString = `${partnerId}${path}${timestamp}`;
  if (tipo === 'shop') {
    baseString += `${accessToken || ''}${shopId || ''}`;
  }
  return gerarAssinatura({ partnerKey, baseString });
}

// Monta a URL de autorização (shop/auth_partner) — o usuário é redirecionado
// pra lá, faz login/consentimento no site da própria Shopee (nunca dentro do
// ERP) e a Shopee redireciona de volta para `redirectUri` com
// ?code=...&shop_id=... anexados. A Shopee não tem um parâmetro `state`
// nativo nesta URL (diferente do Mercado Livre) — por isso o `state` (nossa
// proteção CSRF) vai embutido na própria `redirectUri` como querystring
// (ex.: .../callback?state=XYZ), e a Shopee preserva esse parâmetro ao
// anexar code/shop_id de volta.
function buildAuthorizationUrl({ partnerId, partnerKey, redirectUri }) {
  const path = '/api/v2/shop/auth_partner';
  const timestamp = timestampAtual();
  const sign = assinar({ partnerId, partnerKey, path, timestamp, tipo: 'public' });
  const params = new URLSearchParams({
    partner_id: String(partnerId),
    timestamp: String(timestamp),
    sign,
    redirect: redirectUri,
  });
  return `https://${getHost()}${path}?${params.toString()}`;
}

async function postJson(path, { partnerId, partnerKey, body }) {
  const timestamp = timestampAtual();
  const sign = assinar({ partnerId, partnerKey, path, timestamp, tipo: 'public' });
  const params = new URLSearchParams({ partner_id: String(partnerId), timestamp: String(timestamp), sign });
  const res = await fetchComTimeout(`https://${getHost()}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  // A Shopee devolve HTTP 200 mesmo em erro de negócio (ex.: "wrong sign",
  // código expirado) — o erro real vem no campo `error`/`message` do corpo,
  // nunca só no status HTTP. Tratamos os dois casos.
  if (!res.ok || (data && data.error)) {
    const err = new Error((data && (data.message || data.error)) || `Erro na API da Shopee (${path}).`);
    err.status = res.ok ? 400 : res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function exchangeCodeForToken({ partnerId, partnerKey, code, shopId }) {
  return postJson('/api/v2/auth/token/get', {
    partnerId,
    partnerKey,
    body: { code, shop_id: Number(shopId), partner_id: Number(partnerId) },
  });
}

async function refreshAccessToken({ partnerId, partnerKey, refreshToken, shopId }) {
  return postJson('/api/v2/auth/access_token/get', {
    partnerId,
    partnerKey,
    body: { refresh_token: refreshToken, shop_id: Number(shopId), partner_id: Number(partnerId) },
  });
}

// Chamada GET autenticada de loja (ex.: shop/get_shop_info) — assinatura
// "shop" (inclui access_token + shop_id na base string, além de irem também
// como parâmetros normais da query, exigidos pela própria API).
async function apiShopGet(path, { partnerId, partnerKey, accessToken, shopId }) {
  const timestamp = timestampAtual();
  const sign = assinar({ partnerId, partnerKey, path, timestamp, tipo: 'shop', accessToken, shopId });
  const params = new URLSearchParams({
    partner_id: String(partnerId),
    timestamp: String(timestamp),
    sign,
    access_token: accessToken,
    shop_id: String(shopId),
  });
  const res = await fetchComTimeout(`https://${getHost()}${path}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    const err = new Error((data && (data.message || data.error)) || `Erro na API da Shopee (${path}).`);
    err.status = res.ok ? 400 : res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function obterInfoLoja({ partnerId, partnerKey, accessToken, shopId }) {
  return apiShopGet('/api/v2/shop/get_shop_info', { partnerId, partnerKey, accessToken, shopId });
}

module.exports = {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  obterInfoLoja,
  // exportado só para o teste automatizado conseguir verificar a assinatura
  // sem duplicar a lógica de HMAC (server/test/shopee.test.js)
  _assinar: assinar,
};
