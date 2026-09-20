// Análise de Concorrente — pedido explícito do usuário (19/09/2026): "quero
// que pesquise os modelos de produtos que eu vendo e me entregue um
// relatório de preços mas só quero daqueles concorrentes que estão
// vendendo". Testes de INTEGRAÇÃO (precisa de Postgres local, mesma regra
// de skip por DATABASE_URL dos outros arquivos desta pasta) — mocka
// lib/mercadolivre.js#apiGet (nunca chama a API real, mesmo padrão de
// test/mlAdsFallback.test.js), porque este sandbox não tem acesso à
// internet pra api.mercadolibre.com.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 974;
const CONTA_ID = 974;
const PRODUTO_ID_COM_VENDA = 97400001;
const PRODUTO_ID_SEM_VENDA = 97400002;

describe(
  'Análise de Concorrente — buscarConcorrentesPorProduto (19/09/2026)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste' },
  () => {
    let pool, ml, concorrente, apiGetOriginal;

    before(async () => {
      if (!process.env.ML_TOKEN_KEY) process.env.ML_TOKEN_KEY = nodeCrypto.randomBytes(32).toString('base64');
      pool = require('../db/pool');
      ml = require('../lib/mercadolivre');
      const { encrypt } = require('../lib/crypto');
      concorrente = require('../lib/concorrente');

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '97470707000199', 'EMPRESA TESTE CONCORRENTE', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, 974000001, 'LOJA TESTE CONCORRENTE', $3, $3, now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET access_token_enc = $3, token_expires_at = now() + interval '6 hours', status = 'ativa'`,
        [CONTA_ID, EMPRESA_ID, encrypt('token-de-teste')]
      );
      await pool.query(
        `INSERT INTO produtos (id, empresa_id, nome, sku, custo, ativo) VALUES
           ($1, $2, 'Caixa Teste Com Venda', 'CX-TESTE-CONC', 10, TRUE),
           ($3, $2, 'Caixa Teste Sem Venda', 'CX-TESTE-SEM-VENDA', 10, TRUE)
         ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku`,
        [PRODUTO_ID_COM_VENDA, EMPRESA_ID, PRODUTO_ID_SEM_VENDA]
      );
      const { rows } = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, data_criacao, status)
         VALUES ($1, 9740001, now(), 'paid') RETURNING id`,
        [CONTA_ID]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario)
         VALUES ($1, 'MLB9740001', 'Caixa de Papelão 50x24x15 Reforçada', 'CX-TESTE-CONC', 1, 12.5)`,
        [rows[0].id]
      );
    });

    beforeEach(() => { apiGetOriginal = ml.apiGet; });
    afterEach(() => { ml.apiGet = apiGetOriginal; });

    after(async () => {
      await pool.query('DELETE FROM ml_pedido_itens WHERE pedido_id IN (SELECT id FROM ml_pedidos WHERE conta_ml_id = $1)', [CONTA_ID]);
      await pool.query('DELETE FROM ml_pedidos WHERE conta_ml_id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM produtos WHERE id IN ($1, $2)', [PRODUTO_ID_COM_VENDA, PRODUTO_ID_SEM_VENDA]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
    });

    test('produto sem NENHUMA venda pelo Mercado Livre -> modo "sem_dado", nunca inventa um termo de busca', async () => {
      const r = await concorrente.buscarConcorrentesPorProduto({ empresaId: EMPRESA_ID, produtoId: PRODUTO_ID_SEM_VENDA });
      assert.equal(r.modo, 'sem_dado');
      assert.equal(r.motivo, 'nunca_vendido_no_ml');
      assert.deepEqual(r.concorrentes, []);
    });

    test('anúncio de catálogo: busca os outros vendedores do mesmo catalog_product_id, filtra quem não está vendendo e nunca inclui a própria loja', async () => {
      ml.apiGet = async (path) => {
        if (path === '/items/MLB9740001') {
          return { title: 'Caixa de Papelão 50x24x15 Reforçada', catalog_product_id: 'MLB123456' };
        }
        if (path === '/products/MLB123456/items?site_id=MLB') {
          return {
            results: [
              { seller_id: 974000001, seller: { nickname: 'EU MESMO' }, title: 'x', price: 10, available_quantity: 5, status: 'active' }, // sou eu — nunca aparece
              { seller_id: 555, seller: { nickname: 'CONCORRENTE ATIVO' }, title: 'Caixa X', price: 11.9, available_quantity: 3, status: 'active' },
              { seller_id: 556, seller: { nickname: 'CONCORRENTE SEM ESTOQUE' }, title: 'Caixa Y', price: 9.5, available_quantity: 0, status: 'active' }, // sem estoque — nunca aparece
              { seller_id: 557, seller: { nickname: 'CONCORRENTE PAUSADO' }, title: 'Caixa Z', price: 8.0, available_quantity: 10, status: 'paused' }, // pausado — nunca aparece
            ],
          };
        }
        throw new Error('path inesperado: ' + path);
      };

      const r = await concorrente.buscarConcorrentesPorProduto({ empresaId: EMPRESA_ID, produtoId: PRODUTO_ID_COM_VENDA });
      assert.equal(r.modo, 'catalogo');
      assert.equal(r.concorrentes.length, 1, 'só o concorrente realmente ativo e com estoque deve aparecer');
      assert.equal(r.concorrentes[0].vendedorNickname, 'CONCORRENTE ATIVO');
      assert.equal(r.concorrentes[0].confianca, 'catalogo');
    });

    test('sem catálogo: busca pelo TÍTULO real do anúncio e marca os resultados como "candidato_a_confirmar", nunca certeza', async () => {
      ml.apiGet = async (path) => {
        if (path === '/items/MLB9740001') {
          return { title: 'Caixa de Papelão 50x24x15 Reforçada', catalog_product_id: null };
        }
        if (path.startsWith('/sites/MLB/search?q=')) {
          assert.match(path, /Caixa%20de%20Papel/, 'precisa buscar pelo título real do anúncio, nunca um texto inventado');
          return {
            results: [
              { seller_id: 900, seller: { nickname: 'LOJA PARECIDA' }, title: 'Caixa de Papelão 50x24x15', price: 13, available_quantity: 8, status: 'active' },
            ],
          };
        }
        throw new Error('path inesperado: ' + path);
      };

      const r = await concorrente.buscarConcorrentesPorProduto({ empresaId: EMPRESA_ID, produtoId: PRODUTO_ID_COM_VENDA });
      assert.equal(r.modo, 'busca_por_titulo');
      assert.equal(r.concorrentes.length, 1);
      assert.equal(r.concorrentes[0].confianca, 'candidato_a_confirmar');
    });

    test('produto de outra empresa -> 404 (nunca vaza dado entre empresas)', async () => {
      await assert.rejects(
        () => concorrente.buscarConcorrentesPorProduto({ empresaId: 999999, produtoId: PRODUTO_ID_COM_VENDA }),
        (err) => { assert.equal(err.status, 404); return true; }
      );
    });

    // testarListagemPorVendedor (20/09/2026) — pedido do usuário: dar o link
    // da LOJA uma vez, sem precisar mandar link de anúncio toda vez. Ver
    // comentário grande em lib/concorrente.js. Estes testes mockam
    // ml.apiGet exatamente como os de cima — nunca chamam a API de verdade.
    describe('testarListagemPorVendedor — teste de viabilidade (link da loja -> seller_id -> listagem)', () => {
      const LINK_REAL_DO_USUARIO = 'https://www.mercadolivre.com.br/loja/nzb-embalagens?item_id=MLB4712675795&category_id=MLB270586&official_store_id=79144&client=recoview-selleritems&recos_listing=true#origin=pdp&component=seller&typeSeller=official_store';

      test('caminho feliz: extrai o item_id do link, resolve o seller_id e lista os anúncios ativos dele', async () => {
        ml.apiGet = async (path) => {
          if (path === '/items/MLB4712675795') {
            return { id: 'MLB4712675795', seller_id: 79144000, seller: { nickname: 'NZB EMBALAGENS' } };
          }
          if (path === '/users/79144000/items/search?status=active&limit=20') {
            return { paging: { total: 137 }, results: ['MLB1', 'MLB2', 'MLB3'] };
          }
          throw new Error('path inesperado: ' + path);
        };
        const r = await concorrente.testarListagemPorVendedor({ empresaId: EMPRESA_ID, url: LINK_REAL_DO_USUARIO });
        assert.equal(r.ok, true);
        assert.equal(r.itemId, 'MLB4712675795');
        assert.equal(r.sellerId, 79144000);
        assert.equal(r.vendedorNickname, 'NZB EMBALAGENS');
        assert.equal(r.totalAnunciosAtivos, 137);
        assert.deepEqual(r.algunsIdsRetornados, ['MLB1', 'MLB2', 'MLB3']);
      });

      test('link sem item_id -> falha cedo, explicando o motivo, nunca chama a API à toa', async () => {
        let chamou = false;
        ml.apiGet = async () => { chamou = true; return {}; };
        const r = await concorrente.testarListagemPorVendedor({ empresaId: EMPRESA_ID, url: 'https://www.mercadolivre.com.br/loja/nzb-embalagens' });
        assert.equal(r.ok, false);
        assert.equal(r.etapa, 'extrair_item_id');
        assert.equal(chamou, false);
      });

      test('a API recusa listar os anúncios do vendedor -> devolve o erro real do Mercado Livre, nunca esconde nem inventa sucesso', async () => {
        ml.apiGet = async (path) => {
          if (path === '/items/MLB4712675795') return { id: 'MLB4712675795', seller_id: 79144000 };
          const err = new Error('forbidden');
          err.status = 403;
          err.data = { message: 'forbidden', error: 'forbidden' };
          throw err;
        };
        const r = await concorrente.testarListagemPorVendedor({ empresaId: EMPRESA_ID, url: LINK_REAL_DO_USUARIO });
        assert.equal(r.ok, false);
        assert.equal(r.etapa, 'listar_itens_do_vendedor');
        assert.equal(r.status, 403);
      });

      test('empresa sem conta do Mercado Livre ativa -> erro claro, nunca tenta chamar a API sem token', async () => {
        const r = await concorrente.testarListagemPorVendedor({ empresaId: 999999, url: LINK_REAL_DO_USUARIO });
        assert.equal(r.ok, false);
        assert.equal(r.etapa, 'conta_ml');
      });
    });
  }
);
