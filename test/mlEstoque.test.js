// Testes de lib/mlEstoque.js — Etapa "corrigir a lógica do módulo Estoque"
// (26/08/2026): Mercado Livre como fonte oficial das quantidades.
//
// Parte 1 (sem banco/rede): funções puras de resolução de quantidade —
// mockando só `ml.apiGet` (mesmo padrão de
// mlSync.reconciliacao.integration.test.js).
// Parte 2 (precisa de Postgres local — DATABASE_URL): sincronizarEstoqueConta
// de verdade contra o banco, confirmando idempotência (nunca duplica linha),
// separação Full x não-Full, e "nunca inventa" (formato não reconhecido /
// API sem dado -> pendente, nunca um número).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');

const {
  resolverQuantidadeNaoFull,
  buscarQuantidadeUserProduct,
  buscarQuantidadeFull,
  resolverSku,
} = require('../lib/mlEstoque');

describe('resolverSku — SKU por variação, nunca "chuta" quando a variação não tem SKU próprio e há mais de uma', () => {
  test('usa o SELLER_SKU da própria variação quando existe', () => {
    const item = { attributes: [] };
    const variacao = { attributes: [{ id: 'SELLER_SKU', value_name: 'VAR-1' }] };
    assert.equal(resolverSku(item, variacao), 'VAR-1');
  });

  test('variação sem SKU cai pro SKU do item', () => {
    const item = { attributes: [{ id: 'SELLER_SKU', value_name: 'ITEM-SKU' }] };
    const variacao = { attributes: [] };
    assert.equal(resolverSku(item, variacao), 'ITEM-SKU');
  });

  test('item sem variação usa o SKU do item (seller_custom_field como legado)', () => {
    const item = { attributes: [], seller_custom_field: 'LEGADO-1' };
    assert.equal(resolverSku(item, null), 'LEGADO-1');
  });

  test('sem SKU em lugar nenhum -> null (nunca inventa)', () => {
    assert.equal(resolverSku({ attributes: [] }, { attributes: [] }), null);
  });
});

describe('buscarQuantidadeFull — mesma lógica de lib/mlFull.js', () => {
  test('sem inventory_id -> pendente, nunca 0', async () => {
    const r = await buscarQuantidadeFull(null, 'token');
    assert.equal(r.quantidade, null);
    assert.equal(r.pendente, true);
    assert.equal(r.motivo, 'sem_inventory_id');
  });

  test('API responde available_quantity -> usa esse número', async () => {
    const ml = require('../lib/mercadolivre');
    const original = ml.apiGet;
    ml.apiGet = async (path) => {
      assert.equal(path, '/inventories/INV1/stock/fulfillment');
      return { available_quantity: 42 };
    };
    try {
      const r = await buscarQuantidadeFull('INV1', 'token');
      assert.equal(r.quantidade, 42);
      assert.equal(r.pendente, false);
    } finally { ml.apiGet = original; }
  });

  test('API falha -> pendente, nunca inventa um número', async () => {
    const ml = require('../lib/mercadolivre');
    const original = ml.apiGet;
    ml.apiGet = async () => { throw new Error('falha simulada'); };
    try {
      const r = await buscarQuantidadeFull('INV1', 'token');
      assert.equal(r.quantidade, null);
      assert.equal(r.pendente, true);
      assert.equal(r.motivo, 'erro_api');
    } finally { ml.apiGet = original; }
  });
});

describe('buscarQuantidadeUserProduct — recurso de estoque multi-origem (formato de resposta não confirmado contra a API real, ver docs/05-problemas-conhecidos.md — parsing defensivo)', () => {
  const ml = require('../lib/mercadolivre');
  let original;
  before(() => { original = ml.apiGet; });
  after(() => { ml.apiGet = original; });

  test('sem user_product_id -> pendente', async () => {
    const r = await buscarQuantidadeUserProduct(null, 'token');
    assert.equal(r.pendente, true);
    assert.equal(r.motivo, 'sem_user_product_id');
  });

  test('formato 1: available_quantity direto na raiz', async () => {
    ml.apiGet = async () => ({ available_quantity: 10 });
    const r = await buscarQuantidadeUserProduct('UP1', 'token');
    assert.equal(r.quantidade, 10);
    assert.equal(r.pendente, false);
  });

  test('formato 2: stock.available_quantity', async () => {
    ml.apiGet = async () => ({ stock: { available_quantity: 7 } });
    const r = await buscarQuantidadeUserProduct('UP1', 'token');
    assert.equal(r.quantidade, 7);
    assert.equal(r.pendente, false);
  });

  test('formato 3: soma de locations[].available_quantity', async () => {
    ml.apiGet = async () => ({ locations: [{ id: 'L1', available_quantity: 3 }, { id: 'L2', available_quantity: 5 }] });
    const r = await buscarQuantidadeUserProduct('UP1', 'token');
    assert.equal(r.quantidade, 8);
    assert.equal(r.pendente, false);
  });

  test('locations com algum item sem available_quantity -> nunca soma parcial fingindo ser o total (pendente)', async () => {
    ml.apiGet = async () => ({ locations: [{ id: 'L1', available_quantity: 3 }, { id: 'L2' }] });
    const r = await buscarQuantidadeUserProduct('UP1', 'token');
    assert.equal(r.quantidade, null);
    assert.equal(r.pendente, true);
    assert.equal(r.motivo, 'formato_resposta_nao_reconhecido');
  });

  test('formato completamente desconhecido -> pendente, nunca inventa', async () => {
    ml.apiGet = async () => ({ algo_diferente: true });
    const r = await buscarQuantidadeUserProduct('UP1', 'token');
    assert.equal(r.quantidade, null);
    assert.equal(r.pendente, true);
    assert.equal(r.motivo, 'formato_resposta_nao_reconhecido');
  });

  test('API falha -> pendente', async () => {
    ml.apiGet = async () => { throw new Error('falha'); };
    const r = await buscarQuantidadeUserProduct('UP1', 'token');
    assert.equal(r.pendente, true);
    assert.equal(r.motivo, 'erro_api_user_products');
  });
});

describe('resolverQuantidadeNaoFull — escolhe o recurso certo conforme o anúncio', () => {
  const ml = require('../lib/mercadolivre');
  let original;
  before(() => { original = ml.apiGet; });
  after(() => { ml.apiGet = original; });

  test('sem user_product_id -> usa available_quantity direto (recurso simples)', async () => {
    const item = { available_quantity: 15 };
    const r = await resolverQuantidadeNaoFull(item, null, 'token');
    assert.equal(r.quantidade, 15);
    assert.equal(r.pendente, false);
    assert.equal(r.recurso, 'available_quantity');
    assert.equal(r.userProductId, null);
  });

  test('variação com available_quantity própria (diferente do item) -> usa a da variação', async () => {
    const item = { available_quantity: 999 };
    const variacao = { available_quantity: 5 };
    const r = await resolverQuantidadeNaoFull(item, variacao, 'token');
    assert.equal(r.quantidade, 5);
  });

  test('com user_product_id e API respondendo formato reconhecido -> usa User Products', async () => {
    ml.apiGet = async () => ({ available_quantity: 30 });
    const item = { available_quantity: 999, user_product_id: 'UP1' };
    const r = await resolverQuantidadeNaoFull(item, null, 'token');
    assert.equal(r.quantidade, 30);
    assert.equal(r.recurso, 'user_products');
    assert.equal(r.userProductId, 'UP1');
  });

  test('com user_product_id mas API falha -> cai pro available_quantity como segurança (nunca fica pendente à toa se já tem um número básico)', async () => {
    ml.apiGet = async () => { throw new Error('falha'); };
    const item = { available_quantity: 12, user_product_id: 'UP1' };
    const r = await resolverQuantidadeNaoFull(item, null, 'token');
    assert.equal(r.quantidade, 12);
    assert.equal(r.pendente, false);
    assert.equal(r.recurso, 'available_quantity_fallback');
  });

  test('com user_product_id, API falha E não há available_quantity nenhum -> pendente (nunca inventa)', async () => {
    ml.apiGet = async () => { throw new Error('falha'); };
    const item = { user_product_id: 'UP1' };
    const r = await resolverQuantidadeNaoFull(item, null, 'token');
    assert.equal(r.quantidade, null);
    assert.equal(r.pendente, true);
  });

  test('sem user_product_id e sem available_quantity -> pendente (nunca inventa)', async () => {
    const r = await resolverQuantidadeNaoFull({}, null, 'token');
    assert.equal(r.quantidade, null);
    assert.equal(r.pendente, true);
    assert.equal(r.motivo, 'sem_dado_na_api');
  });
});

// ============================================================
// Parte 2 — integração com banco real (idempotência, separação Full x
// não-Full, upsert por conta_ml_id+ml_item_id+variação+tipo).
// ============================================================
const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 940;
const CONTA_ML_ID = 940;

describe(
  'sincronizarEstoqueConta — integração com Postgres real',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, ml, cryptoLib, sincronizarEstoqueConta, apiGetReal;

    before(async () => {
      if (!process.env.ML_TOKEN_KEY) process.env.ML_TOKEN_KEY = nodeCrypto.randomBytes(32).toString('base64');
      pool = require('../db/pool');
      ml = require('../lib/mercadolivre');
      cryptoLib = require('../lib/crypto');
      ({ sincronizarEstoqueConta } = require('../lib/mlEstoque'));

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'44444444000191','EMPRESA TESTE ESTOQUE',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,940000001,'LOJA TESTE',$3,$4, now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET access_token_enc=EXCLUDED.access_token_enc, refresh_token_enc=EXCLUDED.refresh_token_enc,
           token_expires_at=EXCLUDED.token_expires_at, status='ativa', ultimo_erro=NULL`,
        [CONTA_ML_ID, EMPRESA_ID, cryptoLib.encrypt('fake-access-token'), cryptoLib.encrypt('fake-refresh-token')]
      );
      await pool.query('DELETE FROM ml_estoque_itens WHERE conta_ml_id = $1', [CONTA_ML_ID]);
      apiGetReal = ml.apiGet;
    });

    after(async () => {
      ml.apiGet = apiGetReal;
      await pool.query('DELETE FROM ml_estoque_itens WHERE conta_ml_id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      await pool.end();
    });

    function mockApiComEstoque({ itemFullDisponivel }) {
      return async (path) => {
        if (path.startsWith('/users/940000001/items/search')) {
          return { paging: { total: 2 }, results: ['MLB1', 'MLB2'] };
        }
        if (path.startsWith('/items?ids=MLB1,MLB2')) {
          return [
            {
              code: 200,
              body: {
                id: 'MLB1', title: 'Produto sem Full', status: 'active',
                shipping: { logistic_type: 'drop_off' },
                attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-A' }],
                available_quantity: 20,
              },
            },
            {
              code: 200,
              body: {
                id: 'MLB2', title: 'Produto no Full', status: 'active',
                shipping: { logistic_type: 'fulfillment' }, inventory_id: 'INVX',
                attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-B' }],
              },
            },
          ];
        }
        if (path === '/inventories/INVX/stock/fulfillment') {
          if (itemFullDisponivel) return { available_quantity: 8 };
          throw new Error('erro simulado no Full');
        }
        throw new Error('mock ml.apiGet: rota não coberta neste teste: ' + path);
      };
    }

    test('sincroniza e separa corretamente tipo=proprio (SKU-A) de tipo=full (SKU-B)', async () => {
      ml.apiGet = mockApiComEstoque({ itemFullDisponivel: true });
      const resultado = await sincronizarEstoqueConta(CONTA_ML_ID);
      assert.equal(resultado.totalContaGeral, 2);

      const { rows } = await pool.query('SELECT * FROM ml_estoque_itens WHERE conta_ml_id = $1 ORDER BY ml_item_id', [CONTA_ML_ID]);
      assert.equal(rows.length, 2);

      const proprio = rows.find((r) => r.ml_item_id === 'MLB1');
      assert.equal(proprio.tipo, 'proprio');
      assert.equal(proprio.sku, 'SKU-A');
      assert.equal(proprio.quantidade, 20);
      assert.equal(proprio.pendente, false);
      assert.equal(proprio.loja, 'LOJA TESTE');
      assert.equal(proprio.empresa_id, EMPRESA_ID);

      const full = rows.find((r) => r.ml_item_id === 'MLB2');
      assert.equal(full.tipo, 'full');
      assert.equal(full.sku, 'SKU-B');
      assert.equal(full.quantidade, 8);
      assert.equal(full.recurso_usado, 'full_inventory');
    });

    test('rodar de novo NUNCA duplica linha (idempotência por conta+item+variação+tipo) e atualiza a quantidade (500 -> 800, cenário do usuário)', async () => {
      // 1ª sincronização: SKU-A com 500 (simula estoque inicial no Mercado Livre)
      ml.apiGet = async (path) => {
        const base = mockApiComEstoque({ itemFullDisponivel: true });
        if (path.startsWith('/items?ids=MLB1,MLB2')) {
          return [
            { code: 200, body: { id: 'MLB1', title: 'Produto sem Full', status: 'active', shipping: { logistic_type: 'drop_off' }, attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-A' }], available_quantity: 500 } },
            { code: 200, body: { id: 'MLB2', title: 'Produto no Full', status: 'active', shipping: { logistic_type: 'fulfillment' }, inventory_id: 'INVX', attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-B' }] } },
          ];
        }
        return base(path);
      };
      await sincronizarEstoqueConta(CONTA_ML_ID);
      const antes = await pool.query('SELECT quantidade FROM ml_estoque_itens WHERE conta_ml_id=$1 AND ml_item_id=$2 AND tipo=$3', [CONTA_ML_ID, 'MLB1', 'proprio']);
      assert.equal(antes.rows[0].quantidade, 500);

      // 2ª sincronização: usuário alterou para 800 no Mercado Livre.
      ml.apiGet = async (path) => {
        const base = mockApiComEstoque({ itemFullDisponivel: true });
        if (path.startsWith('/items?ids=MLB1,MLB2')) {
          return [
            { code: 200, body: { id: 'MLB1', title: 'Produto sem Full', status: 'active', shipping: { logistic_type: 'drop_off' }, attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-A' }], available_quantity: 800 } },
            { code: 200, body: { id: 'MLB2', title: 'Produto no Full', status: 'active', shipping: { logistic_type: 'fulfillment' }, inventory_id: 'INVX', attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-B' }] } },
          ];
        }
        return base(path);
      };
      await sincronizarEstoqueConta(CONTA_ML_ID);
      await sincronizarEstoqueConta(CONTA_ML_ID); // roda uma 3ª vez de propósito — idempotência

      const { rows } = await pool.query('SELECT * FROM ml_estoque_itens WHERE conta_ml_id = $1', [CONTA_ML_ID]);
      assert.equal(rows.length, 2, 'nunca deveria duplicar linha em sincronizações repetidas');
      const depois = rows.find((r) => r.ml_item_id === 'MLB1');
      assert.equal(depois.quantidade, 800, 'depois de sincronizar, o ERP deve mostrar 800 (cenário exato pedido pelo usuário)');
    });

    test('quando o Full falha, a linha fica pendente=true/quantidade=null (nunca inventa) sem afetar a linha "proprio"', async () => {
      ml.apiGet = mockApiComEstoque({ itemFullDisponivel: false });
      await sincronizarEstoqueConta(CONTA_ML_ID);
      const { rows } = await pool.query('SELECT * FROM ml_estoque_itens WHERE conta_ml_id = $1 AND ml_item_id=$2', [CONTA_ML_ID, 'MLB2']);
      assert.equal(rows[0].pendente, true);
      assert.equal(rows[0].quantidade, null);
      assert.equal(rows[0].motivo_pendencia, 'erro_api');
    });

    test('item com variações grava uma linha por variação, cada uma com seu próprio SKU e quantidade', async () => {
      ml.apiGet = async (path) => {
        if (path.startsWith('/users/940000001/items/search')) return { paging: { total: 1 }, results: ['MLB3'] };
        if (path.startsWith('/items?ids=MLB3')) {
          return [{
            code: 200,
            body: {
              id: 'MLB3', title: 'Camiseta', status: 'active', shipping: { logistic_type: 'drop_off' }, attributes: [],
              variations: [
                { id: 111, attributes: [{ id: 'SELLER_SKU', value_name: 'CAM-P' }], available_quantity: 3 },
                { id: 222, attributes: [{ id: 'SELLER_SKU', value_name: 'CAM-M' }], available_quantity: 9 },
              ],
            },
          }];
        }
        throw new Error('rota não coberta: ' + path);
      };
      await sincronizarEstoqueConta(CONTA_ML_ID);
      const { rows } = await pool.query('SELECT * FROM ml_estoque_itens WHERE conta_ml_id=$1 AND ml_item_id=$2 ORDER BY ml_variation_id', [CONTA_ML_ID, 'MLB3']);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].sku, 'CAM-P');
      assert.equal(rows[0].quantidade, 3);
      assert.equal(rows[1].sku, 'CAM-M');
      assert.equal(rows[1].quantidade, 9);
    });
  }
);
