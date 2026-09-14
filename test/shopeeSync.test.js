// Testes da sincronização de pedidos da Shopee — Fase 1 (14/09/2026, pedido
// explícito do usuário: "puxar os últimos 60 dias"). Como não há
// credenciais/pedidos reais da Shopee neste ambiente (mesma limitação de
// sempre — ver lib/shopee.js), os testes de rede mockam `global.fetch` só
// para chamadas cujo destino é o host da Shopee (mesmo padrão de
// test/shopee.test.js) — a matemática de janelas de 15 dias e lotes de 50
// é testada tanto isoladamente (pura) quanto through a sincronização
// inteira, mockada.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;

describe('lib/shopeeSync — funções puras (sem rede, sem banco)', () => {
  const { loteArray } = require('../lib/shopeeSync');

  test('loteArray: divide em lotes do tamanho pedido, último lote pode ser menor', () => {
    const arr = Array.from({ length: 120 }, (_, i) => `ORDER-${i}`);
    const lotes = loteArray(arr, 50);
    assert.equal(lotes.length, 3);
    assert.equal(lotes[0].length, 50);
    assert.equal(lotes[1].length, 50);
    assert.equal(lotes[2].length, 20);
  });

  test('loteArray: array vazio devolve zero lotes (nunca uma chamada à API à toa)', () => {
    assert.deepEqual(loteArray([], 50), []);
  });

  test('loteArray: array menor que o tamanho do lote devolve um único lote', () => {
    assert.deepEqual(loteArray(['A', 'B'], 50), [['A', 'B']]);
  });
});

describe(
  'lib/shopeeSync — sincronização real (Postgres real, API da Shopee mockada)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, shopeeCrypto, shopeeSync;
    let fetchOriginal;
    const EMPRESA_ID = 970;
    const CONTA_ID = 970;
    const SHOP_ID = 970001;

    before(async () => {
      process.env.SHOPEE_PARTNER_ID = '2001234';
      process.env.SHOPEE_PARTNER_KEY = 'chave-parceiro-de-teste-bem-secreta';
      pool = require('../db/pool');
      shopeeCrypto = require('../lib/shopeeCrypto');
      if (!process.env.SHOPEE_TOKEN_KEY) process.env.SHOPEE_TOKEN_KEY = shopeeCrypto.generateKey();
      shopeeSync = require('../lib/shopeeSync');

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'97070707000199','EMPRESA TESTE SHOPEE SYNC',TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
    });

    beforeEach(async () => {
      fetchOriginal = global.fetch;
      await pool.query('DELETE FROM shopee_pedido_itens WHERE pedido_id IN (SELECT id FROM shopee_pedidos WHERE conta_shopee_id = $1)', [CONTA_ID]);
      await pool.query('DELETE FROM shopee_pedidos WHERE conta_shopee_id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM shopee_contas WHERE id = $1', [CONTA_ID]);
      await pool.query(
        `INSERT INTO shopee_contas (id, empresa_id, shopee_shop_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, $3, $4, $4, now() + interval '3 hours', 'ativa')`,
        [CONTA_ID, EMPRESA_ID, SHOP_ID, shopeeCrypto.encrypt('token-inicial')]
      );
    });
    afterEach(() => { global.fetch = fetchOriginal; });

    after(async () => {
      await pool.query('DELETE FROM shopee_pedido_itens WHERE pedido_id IN (SELECT id FROM shopee_pedidos WHERE conta_shopee_id = $1)', [CONTA_ID]);
      await pool.query('DELETE FROM shopee_pedidos WHERE conta_shopee_id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM shopee_contas WHERE id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      // pool.end() não é chamado aqui — mesmo motivo documentado em
      // test/shopee.test.js (pool singleton compartilhado pelo processo).
    });

    function mockShopeeFetch(handler) {
      global.fetch = async (url, opts) => {
        const urlStr = String(url);
        if (urlStr.includes('shopeemobile.com')) return handler(new URL(urlStr), opts);
        return fetchOriginal(url, opts);
      };
    }

    test('sincronizarConta: 60 dias vira exatamente 4 janelas de 15 dias, cada order_sn encontrado é detalhado e gravado sem inventar campo nenhum', async () => {
      let chamadasListagem = 0;
      let chamadasDetalhe = 0;
      const janelasVistas = [];

      mockShopeeFetch(async (url) => {
        if (url.pathname === '/api/v2/order/get_order_list') {
          chamadasListagem++;
          const timeFrom = url.searchParams.get('time_from');
          const timeTo = url.searchParams.get('time_to');
          janelasVistas.push([timeFrom, timeTo]);
          // 2 pedidos "novos" por janela, order_sn distinto por chamada
          const n = chamadasListagem;
          return {
            ok: true, status: 200,
            json: async () => ({
              response: {
                more: false,
                next_cursor: '',
                order_list: [{ order_sn: `ORD-W${n}-1`, order_status: 'READY_TO_SHIP' }, { order_sn: `ORD-W${n}-2`, order_status: 'READY_TO_SHIP' }],
              },
            }),
          };
        }
        if (url.pathname === '/api/v2/order/get_order_detail') {
          chamadasDetalhe++;
          const orderSnList = url.searchParams.get('order_sn_list').split(',');
          return {
            ok: true, status: 200,
            json: async () => ({
              response: {
                order_list: orderSnList.map((sn) => ({
                  order_sn: sn,
                  order_status: 'READY_TO_SHIP',
                  create_time: 1700000000,
                  update_time: 1700000100,
                  buyer_user_id: 5551,
                  buyer_username: 'comprador_teste',
                  total_amount: 99.9,
                  payment_method: 'Credit Card',
                  shipping_carrier: 'Transportadora X',
                  actual_shipping_fee: 12.5,
                  // estimated_shipping_fee de propósito AUSENTE — testa que fica NULL, nunca inventado
                  item_list: [
                    { item_id: 111, item_name: 'Produto Teste', model_sku: 'SKU-SHOPEE-1', model_id: 1, model_quantity_purchased: 2, model_discounted_price: 49.95 },
                  ],
                })),
              },
            }),
          };
        }
        throw new Error('endpoint da Shopee inesperado no teste: ' + url.pathname);
      });

      const resultado = await shopeeSync.sincronizarConta(CONTA_ID, { diasAtras: 60 });

      assert.equal(chamadasListagem, 4, 'deveria ter buscado exatamente 4 janelas de 15 dias pra 60 dias');
      assert.equal(chamadasDetalhe, 4, 'cada janela (2 pedidos, bem abaixo do lote de 50) deveria virar 1 chamada de detalhe');
      assert.equal(resultado.totalEncontrados, 8);
      assert.equal(resultado.importados, 8);
      assert.deepEqual(resultado.erros, []);

      // janelas não se sobrepõem e cobrem os 60 dias inteiros, uma emendando na outra
      for (let i = 1; i < janelasVistas.length; i++) {
        assert.equal(janelasVistas[i][0], janelasVistas[i - 1][1], 'janela seguinte deveria começar exatamente onde a anterior terminou');
      }

      const { rows } = await pool.query('SELECT * FROM shopee_pedidos WHERE conta_shopee_id = $1 ORDER BY order_sn', [CONTA_ID]);
      assert.equal(rows.length, 8);
      const pedido = rows.find((r) => r.order_sn === 'ORD-W1-1');
      assert.equal(pedido.order_status, 'READY_TO_SHIP');
      assert.equal(Number(pedido.valor_total), 99.9);
      assert.equal(pedido.comprador_username, 'comprador_teste');
      assert.equal(Number(pedido.frete_real), 12.5);
      assert.equal(pedido.frete_estimado, null, 'campo que a Shopee não mandou fica NULL, nunca inventado');
      assert.ok(pedido.raw_pedido, 'payload bruto precisa estar salvo pra auditoria');

      const { rows: itens } = await pool.query('SELECT * FROM shopee_pedido_itens WHERE pedido_id = $1', [pedido.id]);
      assert.equal(itens.length, 1);
      assert.equal(itens[0].sku, 'SKU-SHOPEE-1');
      assert.equal(itens[0].quantidade, 2);
      assert.equal(Number(itens[0].valor_total_item), 99.9); // 49.95 x 2

      const { rows: contaRows } = await pool.query('SELECT ultima_sincronizacao_em, status, ultimo_erro FROM shopee_contas WHERE id = $1', [CONTA_ID]);
      assert.ok(contaRows[0].ultima_sincronizacao_em);
      assert.equal(contaRows[0].status, 'ativa');
      assert.equal(contaRows[0].ultimo_erro, null);
    });

    test('sincronizarConta: ressincronizar o MESMO pedido nunca duplica (upsert) e substitui os itens pelos atuais', async () => {
      mockShopeeFetch(async (url) => {
        if (url.pathname === '/api/v2/order/get_order_list') {
          return { ok: true, status: 200, json: async () => ({ response: { more: false, order_list: [{ order_sn: 'ORD-REPETIDO', order_status: 'READY_TO_SHIP' }] } }) };
        }
        if (url.pathname === '/api/v2/order/get_order_detail') {
          return {
            ok: true, status: 200,
            json: async () => ({
              response: {
                order_list: [{
                  order_sn: 'ORD-REPETIDO', order_status: 'SHIPPED', total_amount: 50,
                  item_list: [{ item_id: 1, item_name: 'Item novo pós-ressync', model_sku: 'SKU-NOVO', model_quantity_purchased: 1, model_discounted_price: 50 }],
                }],
              },
            }),
          };
        }
        throw new Error('endpoint inesperado: ' + url.pathname);
      });

      await shopeeSync.sincronizarConta(CONTA_ID, { diasAtras: 1 });
      await shopeeSync.sincronizarConta(CONTA_ID, { diasAtras: 1 }); // roda de novo

      const { rows } = await pool.query('SELECT * FROM shopee_pedidos WHERE conta_shopee_id = $1 AND order_sn = $2', [CONTA_ID, 'ORD-REPETIDO']);
      assert.equal(rows.length, 1, 'nunca deveria duplicar a mesma order_sn');
      assert.equal(rows[0].order_status, 'SHIPPED');

      const { rows: itens } = await pool.query('SELECT * FROM shopee_pedido_itens WHERE pedido_id = $1', [rows[0].id]);
      assert.equal(itens.length, 1, 'itens antigos deveriam ter sido substituídos, nunca acumulados');
      assert.equal(itens[0].sku, 'SKU-NOVO');
    });

    test('sincronizarConta: erro numa janela (ex.: Shopee rejeita a chamada) não impede as demais, e fica registrado em erros', async () => {
      let chamadasListagem = 0;
      mockShopeeFetch(async (url) => {
        if (url.pathname === '/api/v2/order/get_order_list') {
          chamadasListagem++;
          if (chamadasListagem === 2) {
            return { ok: true, status: 200, json: async () => ({ error: 'error_param', message: 'parâmetro inválido (simulado)' }) };
          }
          return { ok: true, status: 200, json: async () => ({ response: { more: false, order_list: [] } }) };
        }
        throw new Error('endpoint inesperado: ' + url.pathname);
      });

      const resultado = await shopeeSync.sincronizarConta(CONTA_ID, { diasAtras: 60 });
      assert.equal(chamadasListagem, 4, 'as outras 3 janelas deveriam ter sido tentadas mesmo com a 2ª falhando');
      assert.equal(resultado.erros.length, 1);
      assert.match(resultado.erros[0].erro, /parâmetro inválido/);

      const { rows } = await pool.query('SELECT ultimo_erro FROM shopee_contas WHERE id = $1', [CONTA_ID]);
      assert.match(rows[0].ultimo_erro, /1 janela/);
    });
  }
);
