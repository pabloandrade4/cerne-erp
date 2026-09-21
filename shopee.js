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
// como parâmetros normais da query, exigidos pela própria API). `params`
// (opcional, adicionado 14/09/2026 para os endpoints de pedidos) leva
// parâmetros extras específicos do endpoint (ex.: time_from/time_to) — eles
// NUNCA entram no cálculo da assinatura (só partner_id+path+timestamp+
// access_token+shop_id entram, ver `assinar` acima), só na query string.
async function apiShopGet(path, { partnerId, partnerKey, accessToken, shopId, params: extra }) {
  const timestamp = timestampAtual();
  const sign = assinar({ partnerId, partnerKey, path, timestamp, tipo: 'shop', accessToken, shopId });
  const params = new URLSearchParams({
    partner_id: String(partnerId),
    timestamp: String(timestamp),
    sign,
    access_token: accessToken,
    shop_id: String(shopId),
  });
  for (const [chave, valor] of Object.entries(extra || {})) {
    if (valor !== undefined && valor !== null && valor !== '') params.set(chave, String(valor));
  }
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

// POST autenticada de loja — mesma assinatura "shop" de apiShopGet acima
// (partner_id+path+timestamp+access_token+shop_id, todos na query string),
// só que o corpo da chamada vai em JSON no corpo da requisição (POST) em vez
// de todo mundo virar parâmetro de query (GET). Adicionada em 14/09/2026 só
// pro repasse/comissão (obterDetalhesRepasse abaixo), que a documentação da
// Shopee (cruzada com SDKs de terceiros — ver comentário abaixo) diz ser
// POST com order_sn_list no corpo, diferente das chamadas GET já usadas
// nesta etapa.
async function apiShopPost(path, { partnerId, partnerKey, accessToken, shopId, body }) {
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
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

// ============================================================
// Repasse/comissão real (Fase 2b, 14/09/2026 — pedido explícito do usuário:
// "quero igual ao mercado livre, mas com as taxas e comissões da shopee").
// A Shopee NÃO devolve comissão/tarifas junto do pedido (get_order_detail
// acima) — só num endpoint de repasse separado
// (payment/get_escrow_detail_batch), documentado publicamente pela Shopee e
// cruzado, nesta etapa, com um SDK de terceiros de código aberto (este
// ambiente não consegue abrir open.shopee.com direto — ver comentário no
// topo do arquivo). PRIMEIRA vez que este projeto chama este endpoint:
// ainda não confirmado contra uma resposta real desta conta. Os nomes de
// campo usados no cálculo (commission_fee, seller_transaction_fee,
// service_fee, escrow_amount) vêm dessa documentação cruzada —
// lib/shopeeSync.js guarda a resposta bruta de cada pedido (raw_repasse),
// então nenhum dado real se perde mesmo que algum nome de campo precise de
// ajuste depois da primeira chamada de verdade.
// ============================================================

// POST /api/v2/payment/get_escrow_detail_batch — repasse de até 50 pedidos
// por chamada (limite documentado pela Shopee; a própria documentação
// recomenda lotes menores, de 1 a 20, para melhor performance —
// lib/shopeeSync.js quem decide o tamanho do lote, nunca esta função). Um
// pedido cujo repasse a Shopee ainda não processou/liberou (ex.: ainda não
// pago) simplesmente não aparece com dado de comissão na resposta — nunca
// um erro que derruba o lote inteiro.
async function obterDetalhesRepasse({ partnerId, partnerKey, accessToken, shopId, orderSnList }) {
  return apiShopPost('/api/v2/payment/get_escrow_detail_batch', {
    partnerId, partnerKey, accessToken, shopId,
    body: { order_sn_list: orderSnList },
  });
}

// ============================================================
// Pedidos (Fase 1 da sincronização, 14/09/2026 — pedido explícito do
// usuário: "puxar os últimos 60 dias"). IMPORTANTE (mesma honestidade já
// registrada no topo deste arquivo sobre a limitação deste ambiente de não
// conseguir abrir open.shopee.com pra conferir a documentação byte a byte):
// os nomes de parâmetro/campo abaixo seguem a documentação pública estável
// da API de Pedidos v2 da Shopee, mas esta é a PRIMEIRA sincronização de
// pedidos deste projeto — ainda não testada contra a API de verdade. Se a
// própria Shopee rejeitar algum parâmetro (erro claro no campo
// `error`/`message` da resposta, como já acontece com "wrong sign"), o
// texto do erro aparece no resultado da sincronização — não falha
// silenciosamente. lib/shopeeSync.js sempre guarda o payload bruto de cada
// pedido (raw_pedido), então nenhum dado real se perde mesmo que algum
// campo normalizado precise de ajuste depois da primeira sincronização real.
// ============================================================

// GET /api/v2/order/get_order_list — resumo de pedidos (order_sn + status)
// num período. A Shopee limita esta chamada a no máximo 15 dias entre
// timeFrom/timeTo (ambos em SEGUNDOS, unix epoch) — lib/shopeeSync.js quem
// garante isso, nunca esta função. Pagina via cursor (resposta traz
// `more`/`next_cursor`).
async function listarPedidos({ partnerId, partnerKey, accessToken, shopId, timeFrom, timeTo, cursor, pageSize = 100 }) {
  return apiShopGet('/api/v2/order/get_order_list', {
    partnerId, partnerKey, accessToken, shopId,
    params: {
      time_range_field: 'create_time',
      time_from: timeFrom,
      time_to: timeTo,
      page_size: pageSize,
      cursor: cursor || '',
    },
  });
}

// Campos opcionais pedidos no detalhe do pedido — a Shopee só devolve o que
// for pedido explicitamente aqui (diferente do Mercado Livre, onde o
// pedido já vem completo). Lista conservadora, só com os campos que este
// ERP usa nesta Fase 1.
const CAMPOS_DETALHE_PEDIDO = 'buyer_user_id,buyer_username,item_list,total_amount,payment_method,shipping_carrier,actual_shipping_fee,estimated_shipping_fee';

// GET /api/v2/order/get_order_detail — detalhe completo de até 50 pedidos
// por chamada (limite documentado pela Shopee — lib/shopeeSync.js quem
// separa em lotes, nunca esta função).
async function obterDetalhesPedidos({ partnerId, partnerKey, accessToken, shopId, orderSnList }) {
  return apiShopGet('/api/v2/order/get_order_detail', {
    partnerId, partnerKey, accessToken, shopId,
    params: {
      order_sn_list: orderSnList.join(','),
      response_optional_fields: CAMPOS_DETALHE_PEDIDO,
    },
  });
}

// ============================================================================
// SAC (Chat e Devoluções) — 14/09/2026, agente "SAC Shopee" (ver
// lib/ia/sacShopee.js). Só LEITURA. IMPORTANTE (mesma honestidade já
// registrada no topo deste arquivo): esta é a PRIMEIRA vez que este projeto
// chama estas duas APIs, e a documentação oficial (open.shopee.com) não
// pôde ser aberta direto neste ambiente pra conferir path/campo byte a
// byte — os nomes abaixo seguem a referência pública mais estável
// encontrada (namespace "sellerchat" pra chat, "returns" pra devoluções).
// lib/ia/sacShopee.js isola cada chamada com try/catch e nunca fabrica um
// atendimento no lugar de um erro — se a Shopee rejeitar o path/parâmetro,
// o erro aparece no resultado da sincronização pra ajustar depois.
// ============================================================================

// GET /api/v2/sellerchat/get_conversation_list — lista as conversas do chat
// pós-venda da loja, mais recentes primeiro.
async function buscarConversas({ partnerId, partnerKey, accessToken, shopId, pageSize = 50, cursor }) {
  return apiShopGet('/api/v2/sellerchat/get_conversation_list', {
    partnerId, partnerKey, accessToken, shopId,
    params: { page_size: pageSize, direction: 'latest', cursor: cursor || '' },
  });
}

// GET /api/v2/sellerchat/get_message — mensagens de UMA conversa
// (conversation_id), mais recentes primeiro.
async function buscarMensagensConversa({ partnerId, partnerKey, accessToken, shopId, conversationId, pageSize = 25 }) {
  return apiShopGet('/api/v2/sellerchat/get_message', {
    partnerId, partnerKey, accessToken, shopId,
    params: { conversation_id: conversationId, page_size: pageSize },
  });
}

// GET /api/v2/returns/get_return_list — devoluções/reembolsos abertos
// contra a loja num período (create_time, em segundos).
async function buscarDevolucoes({ partnerId, partnerKey, accessToken, shopId, timeFrom, timeTo, pageSize = 50, cursor = 0 }) {
  return apiShopGet('/api/v2/returns/get_return_list', {
    partnerId, partnerKey, accessToken, shopId,
    params: { create_time_from: timeFrom, create_time_to: timeTo, page_size: pageSize, page_no: cursor },
  });
}

// GET /api/v2/returns/get_return_detail — detalhe de uma devolução
// específica (return_sn), com o motivo e as mensagens do comprador.
async function buscarDetalheDevolucao({ partnerId, partnerKey, accessToken, shopId, returnSn }) {
  return apiShopGet('/api/v2/returns/get_return_detail', {
    partnerId, partnerKey, accessToken, shopId,
    params: { return_sn: returnSn },
  });
}

module.exports = {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  obterInfoLoja,
  listarPedidos,
  obterDetalhesPedidos,
  obterDetalhesRepasse,
  buscarConversas,
  buscarMensagensConversa,
  buscarDevolucoes,
  buscarDetalheDevolucao,
  // exportado só para o teste automatizado conseguir verificar a assinatura
  // sem duplicar a lógica de HMAC (server/test/shopee.test.js)
  _assinar: assinar,
};
