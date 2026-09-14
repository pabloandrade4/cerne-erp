// Testes PUROS (sem banco, sem rede) de lib/mlPromocoes.js — primeira etapa
// (12/09/2026) do pedido "agente de IA para gerenciar a central de
// promoções". Nesta etapa a função só faz um GET de diagnóstico e nunca
// aplica/edita/remove nada — os testes cobrem exatamente isso: repassa o
// dado real quando a API responde bem, e nunca lança/inventa nada quando a
// API falha (mesmo padrão de mock por propriedade de módulo já usado em
// test/mlAds.test.js, porque lib/mercadolivre.js é referenciado como
// módulo inteiro — `ml.apiGet(...)` — não desestruturado).
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ml = require('../lib/mercadolivre');
const { buscarPromocoesDaConta, buscarItensDaPromocao } = require('../lib/mlPromocoes');

describe('buscarPromocoesDaConta — diagnóstico (12/09/2026)', () => {
  const apiGetOriginal = ml.apiGet;
  afterEach(() => { ml.apiGet = apiGetOriginal; });

  test('sucesso: devolve ok=true, status=200 e o corpo exatamente como a API respondeu (nunca recalculado)', async () => {
    const corpoReal = { promotions: [{ id: 'X1', type: 'DEAL', status: 'started' }] };
    let chamadaComPath = null;
    ml.apiGet = async (path) => { chamadaComPath = path; return corpoReal; };

    const r = await buscarPromocoesDaConta('token-abc', '999888777');

    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, corpoReal);
    assert.equal(chamadaComPath, '/seller-promotions/users/999888777?app_version=v2');
  });

  test('erro da API (ex: 403 sem permissão do app): nunca lança — devolve status/erro/detalhe reais', async () => {
    ml.apiGet = async () => {
      const err = new Error('Invalid caller.id / app sem permissão para este recurso.');
      err.status = 403;
      err.data = { message: 'forbidden', error: 'forbidden' };
      throw err;
    };

    const r = await buscarPromocoesDaConta('token-abc', '999888777');

    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.erro, 'Invalid caller.id / app sem permissão para este recurso.');
    assert.deepEqual(r.detalheApi, { message: 'forbidden', error: 'forbidden' });
  });

  test('erro de rede (sem status/data): ainda devolve um objeto estruturado, nunca quebra quem chamou', async () => {
    ml.apiGet = async () => { throw new Error('Tempo limite excedido.'); };

    const r = await buscarPromocoesDaConta('token-abc', '999888777');

    assert.equal(r.ok, false);
    assert.equal(r.status, null);
    assert.equal(r.erro, 'Tempo limite excedido.');
    assert.equal(r.detalheApi, null);
  });
});

// Confirmado AO VIVO em 13/09/2026 (conta real PFEMBALAGEMS): o app já tem
// permissão pra essa API — GET /seller-promotions/users/{id}?app_version=v2
// devolveu 6 promoções reais e ativas (LIGHTNING, SMART x2, SELLER_CAMPAIGN,
// SELLER_COUPON_CAMPAIGN, DEAL). Próximo dado real a confirmar: os ITENS de
// cada uma (preço/desconto/produto), por isso buscarItensDaPromocao abaixo.
describe('buscarItensDaPromocao — diagnóstico dos itens de uma promoção (13/09/2026)', () => {
  const apiGetOriginal = ml.apiGet;
  afterEach(() => { ml.apiGet = apiGetOriginal; });

  test('sucesso: manda promotion_type + user_id + app_version=v2 e devolve o corpo real, sem recalcular nada', async () => {
    const corpoReal = { results: [{ id: 'MLB111', price: 90, original_price: 100 }] };
    let chamadaComPath = null;
    ml.apiGet = async (path) => { chamadaComPath = path; return corpoReal; };

    const r = await buscarItensDaPromocao('token-abc', '2486380051', 'P-MLB18049186', 'DEAL');

    assert.equal(r.ok, true);
    assert.deepEqual(r.data, corpoReal);
    assert.equal(chamadaComPath, '/seller-promotions/promotions/P-MLB18049186/items?promotion_type=DEAL&user_id=2486380051&app_version=v2');
  });

  test('erro da API: nunca lança — devolve status/erro/detalhe reais', async () => {
    ml.apiGet = async () => {
      const err = new Error('promotion not found');
      err.status = 404;
      err.data = { message: 'promotion not found' };
      throw err;
    };

    const r = await buscarItensDaPromocao('token-abc', '2486380051', 'X-INEXISTENTE', 'DEAL');

    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.erro, 'promotion not found');
  });
});
