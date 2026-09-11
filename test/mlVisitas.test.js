// Testes PUROS (sem banco, sem rede) da correção de 11/09/2026 em
// lib/mlVisitas.js: evidência real em produção (conta PFEMBALAGEMS) mostrou
// que GET /items/visits só aceita UM id por chamada — chamar com vários
// IDs (como o código fazia antes, em lotes de 20) devolve HTTP 400
// "maximum amount of items to query is 1". Este teste mocka
// lib/mercadolivre.js#apiGet (nunca chama a API real) pra garantir que:
// 1) cada anúncio gera sua própria chamada (nunca ids=A,B juntos);
// 2) a resposta de UM item só ({item_id,total_visits} no topo) é entendida;
// 3) uma falha isolada não derruba os outros anúncios (parcial:true);
// 4) todas falhando devolve disponivel:false com o motivo real.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ml = require('../lib/mercadolivre');
const { buscarVisitasPorPeriodo } = require('../lib/mlVisitas');

describe('mlVisitas — uma chamada por anúncio (nunca em lote, ver correção 11/09/2026)', () => {
  let apiGetOriginal;
  beforeEach(() => { apiGetOriginal = ml.apiGet; });
  afterEach(() => { ml.apiGet = apiGetOriginal; });

  test('cada anúncio gera sua própria chamada com ids=<um-id-só>, nunca vários IDs juntos', async () => {
    const chamadas = [];
    ml.apiGet = async (path) => {
      chamadas.push(path);
      const params = new URLSearchParams(path.split('?')[1]);
      const id = params.get('ids');
      return { item_id: id, total_visits: id === 'MLB1' ? 10 : 20 };
    };

    const r = await buscarVisitasPorPeriodo({ accessToken: 'tok', itemIds: ['MLB1', 'MLB2'], desde: '2026-08-01', ate: '2026-08-26' });
    assert.equal(r.disponivel, true);
    assert.equal(r.parcial, false);
    assert.equal(r.porItem.get('MLB1'), 10);
    assert.equal(r.porItem.get('MLB2'), 20);
    assert.equal(chamadas.length, 2, 'uma chamada por anúncio');
    chamadas.forEach((c) => {
      const ids = new URLSearchParams(c.split('?')[1]).get('ids');
      assert.equal(ids.includes(','), false, 'nunca deve mandar mais de um ID por chamada — API real rejeita com HTTP 400');
    });
  });

  test('resposta de um item só no formato {item_id, total_visits} é entendida (formato real confirmado em produção)', async () => {
    ml.apiGet = async () => ({ item_id: 'MLB1', total_visits: 42, date_from: '2026-08-01', date_to: '2026-08-26' });
    const r = await buscarVisitasPorPeriodo({ accessToken: 'tok', itemIds: ['MLB1'], desde: '2026-08-01', ate: '2026-08-26' });
    assert.equal(r.disponivel, true);
    assert.equal(r.porItem.get('MLB1'), 42);
  });

  test('um anúncio com erro não derruba os outros — parcial:true, o anúncio com erro fica de fora do Map', async () => {
    ml.apiGet = async (path) => {
      const id = new URLSearchParams(path.split('?')[1]).get('ids');
      if (id === 'MLB2') { const err = new Error('erro'); err.status = 500; throw err; }
      return { item_id: id, total_visits: 5 };
    };
    const r = await buscarVisitasPorPeriodo({ accessToken: 'tok', itemIds: ['MLB1', 'MLB2', 'MLB3'], desde: '2026-08-01', ate: '2026-08-26' });
    assert.equal(r.disponivel, true);
    assert.equal(r.parcial, true);
    assert.equal(r.porItem.get('MLB1'), 5);
    assert.equal(r.porItem.has('MLB2'), false, 'anúncio com erro fica indisponível, nunca um valor inventado');
    assert.equal(r.porItem.get('MLB3'), 5);
  });

  test('todos os anúncios falham — disponivel:false, com o motivo real da API', async () => {
    ml.apiGet = async () => {
      const err = new Error('maximum amount of items to query is 1');
      err.status = 400;
      err.data = { message: 'maximum amount of items to query is 1' };
      throw err;
    };
    const r = await buscarVisitasPorPeriodo({ accessToken: 'tok', itemIds: ['MLB1', 'MLB2'], desde: '2026-08-01', ate: '2026-08-26' });
    assert.equal(r.disponivel, false);
    assert.equal(r.motivo, 'erro_api');
    assert.match(r.mensagem, /maximum amount of items to query is 1/);
  });

  test('nunca chama a API quando a lista de anúncios está vazia', async () => {
    let chamou = false;
    ml.apiGet = async () => { chamou = true; return {}; };
    const r = await buscarVisitasPorPeriodo({ accessToken: 'tok', itemIds: [], desde: '2026-08-01', ate: '2026-08-26' });
    assert.equal(r.disponivel, true);
    assert.equal(r.porItem.size, 0);
    assert.equal(chamou, false);
  });
});
