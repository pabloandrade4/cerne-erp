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
    let pool, ml, concorrente, apiGetOriginal, apiGetPublicoOriginal;

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

    beforeEach(() => { apiGetOriginal = ml.apiGet; apiGetPublicoOriginal = ml.apiGetPublico; });
    afterEach(() => { ml.apiGet = apiGetOriginal; ml.apiGetPublico = apiGetPublicoOriginal; });

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

    // Correção de bug real (20/09/2026): o usuário reportou "erro interno do
    // servidor" na tela; log de produção confirmou que o 403 do bloqueio do
    // Mercado Livre (busca por título) subia sem ser tratado e virava um 500
    // genérico. Agora nunca lança — devolve modo:'busca_bloqueada' com o
    // motivo real.
    test('busca por título bloqueada pelo Mercado Livre (403) -> nunca quebra, devolve modo "busca_bloqueada" com o motivo real', async () => {
      ml.apiGet = async (path) => {
        if (path === '/items/MLB9740001') {
          return { title: 'Caixa de Papelão 50x24x15 Reforçada', catalog_product_id: null };
        }
        if (path.startsWith('/sites/MLB/search?q=')) {
          const err = new Error('forbidden');
          err.status = 403;
          err.data = { message: 'forbidden', error: 'forbidden' };
          throw err;
        }
        throw new Error('path inesperado: ' + path);
      };

      const r = await concorrente.buscarConcorrentesPorProduto({ empresaId: EMPRESA_ID, produtoId: PRODUTO_ID_COM_VENDA });
      assert.equal(r.modo, 'busca_bloqueada');
      assert.equal(r.motivo, 'busca_por_titulo_bloqueada_pelo_ml');
      assert.deepEqual(r.concorrentes, []);
      assert.ok(r.mensagem && r.mensagem.length > 0);
    });

    // testarListagemPorVendedor (20/09/2026) — pedido do usuário: dar o link
    // da LOJA uma vez, sem precisar mandar link de anúncio toda vez. Ver
    // comentário grande em lib/concorrente.js. Estes testes mockam
    // ml.apiGet/ml.apiGetPublico exatamente como os de cima — nunca chamam
    // a API de verdade.
    describe('testarListagemPorVendedor — teste de viabilidade (link da loja -> seller_id -> listagem)', () => {
      const LINK_REAL_DO_USUARIO = 'https://www.mercadolivre.com.br/loja/nzb-embalagens?item_id=MLB4712675795&category_id=MLB270586&official_store_id=79144&client=recoview-selleritems&recos_listing=true#origin=pdp&component=seller&typeSeller=official_store';

      test('caminho feliz: extrai o item_id do link, resolve o seller_id e lista os anúncios ativos dele (tudo autenticado)', async () => {
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
        assert.equal(r.itemBuscadoSemLogin, false);
        assert.equal(r.listagemBuscadaSemLogin, false);
      });

      test('link sem item_id -> falha cedo, explicando o motivo, nunca chama a API à toa', async () => {
        let chamou = false;
        ml.apiGet = async () => { chamou = true; return {}; };
        ml.apiGetPublico = async () => { chamou = true; return {}; };
        const r = await concorrente.testarListagemPorVendedor({ empresaId: EMPRESA_ID, url: 'https://www.mercadolivre.com.br/loja/nzb-embalagens' });
        assert.equal(r.ok, false);
        assert.equal(r.etapa, 'extrair_item_id');
        assert.equal(chamou, false);
      });

      // 20/09/2026 — cenário do teste REAL feito pelo usuário na produção:
      // GET /items/{id} recusado (403 access_denied) mesmo autenticado.
      // Antes desta mudança, a função desistia direto aqui — agora tenta
      // de novo SEM login (dado de catálogo tradicionalmente é público),
      // pra separar "bloqueio por causa do token" de "bloqueio total".
      test('busca do item bloqueada (403) autenticado -> tenta de novo sem login; se também falhar, devolve os dois erros reais, nunca esconde nem inventa', async () => {
        ml.apiGet = async () => {
          const err = new Error('access_denied');
          err.status = 403;
          err.data = { message: 'Access to the requested resource is forbidden', error: 'access_denied', status: 403, cause: null };
          throw err;
        };
        ml.apiGetPublico = async () => {
          const err = new Error('access_denied');
          err.status = 403;
          err.data = { message: 'Access to the requested resource is forbidden', error: 'access_denied', status: 403, cause: null };
          throw err;
        };
        const r = await concorrente.testarListagemPorVendedor({ empresaId: EMPRESA_ID, url: LINK_REAL_DO_USUARIO });
        assert.equal(r.ok, false);
        assert.equal(r.etapa, 'buscar_item');
        assert.equal(r.autenticado.status, 403);
        assert.equal(r.semLogin.status, 403);
      });

      test('busca do item bloqueada autenticado, mas funciona sem login -> segue o teste normalmente e sinaliza itemBuscadoSemLogin', async () => {
        ml.apiGet = async (path) => {
          if (path === '/items/MLB4712675795') {
            const err = new Error('forbidden');
            err.status = 403;
            err.data = { message: 'forbidden' };
            throw err;
          }
          if (path === '/users/79144000/items/search?status=active&limit=20') {
            return { paging: { total: 50 }, results: ['MLB9'] };
          }
          throw new Error('path inesperado: ' + path);
        };
        ml.apiGetPublico = async (path) => {
          if (path === '/items/MLB4712675795') {
            return { id: 'MLB4712675795', seller_id: 79144000, seller: { nickname: 'NZB EMBALAGENS' } };
          }
          throw new Error('path inesperado (público): ' + path);
        };
        const r = await concorrente.testarListagemPorVendedor({ empresaId: EMPRESA_ID, url: LINK_REAL_DO_USUARIO });
        assert.equal(r.ok, true);
        assert.equal(r.itemBuscadoSemLogin, true);
        assert.equal(r.listagemBuscadaSemLogin, false);
      });

      test('a API recusa listar os anúncios do vendedor autenticado E sem login -> devolve os dois erros reais, nunca esconde nem inventa sucesso', async () => {
        ml.apiGet = async (path) => {
          if (path === '/items/MLB4712675795') return { id: 'MLB4712675795', seller_id: 79144000 };
          const err = new Error('forbidden');
          err.status = 403;
          err.data = { message: 'forbidden', error: 'forbidden' };
          throw err;
        };
        ml.apiGetPublico = async () => {
          const err = new Error('forbidden');
          err.status = 403;
          err.data = { message: 'forbidden', error: 'forbidden' };
          throw err;
        };
        const r = await concorrente.testarListagemPorVendedor({ empresaId: EMPRESA_ID, url: LINK_REAL_DO_USUARIO });
        assert.equal(r.ok, false);
        assert.equal(r.etapa, 'listar_itens_do_vendedor');
        assert.equal(r.autenticado.status, 403);
        assert.equal(r.semLogin.status, 403);
      });

      test('empresa sem conta do Mercado Livre ativa -> erro claro, nunca tenta chamar a API sem token', async () => {
        const r = await concorrente.testarListagemPorVendedor({ empresaId: 999999, url: LINK_REAL_DO_USUARIO });
        assert.equal(r.ok, false);
        assert.equal(r.etapa, 'conta_ml');
      });
    });
  }
);

// ============================================================================
// Cadastro manual de concorrente por SKU (20/09/2026) — ver comentário
// grande em lib/concorrente.js e db/schema.sql (tabela
// concorrentes_monitorados). Resposta direta do usuário ao bloqueio da
// descoberta automática: "sobre o concorrente eu vou mandar o link do
// anuncio do concorrente para ficar mais facil". Nenhuma chamada à API do
// Mercado Livre nestes testes — é CRUD puro contra o Postgres.
describe(
  'Cadastro manual de concorrente — concorrentes_monitorados (20/09/2026)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste' },
  () => {
    let pool, concorrente;
    const EMPRESA_ID_CADASTRO = 975;

    before(async () => {
      pool = require('../db/pool');
      concorrente = require('../lib/concorrente');
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '97570707000199', 'EMPRESA TESTE CADASTRO CONCORRENTE', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID_CADASTRO]
      );
    });

    afterEach(async () => {
      await pool.query('DELETE FROM concorrentes_monitorados WHERE empresa_id = $1', [EMPRESA_ID_CADASTRO]);
    });

    after(async () => {
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID_CADASTRO]);
    });

    test('cadastrarConcorrente exige sku e url — nunca grava cadastro incompleto', async () => {
      await assert.rejects(
        () => concorrente.cadastrarConcorrente({ empresaId: EMPRESA_ID_CADASTRO, sku: '', url: 'https://exemplo.com/x' }),
        (err) => { assert.equal(err.status, 400); return true; }
      );
      await assert.rejects(
        () => concorrente.cadastrarConcorrente({ empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-1', url: '' }),
        (err) => { assert.equal(err.status, 400); return true; }
      );
    });

    test('cadastrarConcorrente grava e listarConcorrentesMonitorados devolve só os ativos da empresa', async () => {
      const linha = await concorrente.cadastrarConcorrente({
        empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-1', url: 'https://exemplo.com/anuncio-concorrente', apelido: 'Loja Rival',
      });
      assert.equal(linha.sku, 'CX-1');
      assert.equal(linha.url, 'https://exemplo.com/anuncio-concorrente');
      assert.equal(linha.apelido, 'Loja Rival');
      assert.equal(linha.ativo, true);

      const listados = await concorrente.listarConcorrentesMonitorados({ empresaId: EMPRESA_ID_CADASTRO });
      assert.equal(listados.length, 1);
      assert.equal(listados[0].id, linha.id);
    });

    test('cadastrar o MESMO sku+url de novo (empresa igual) nunca duplica — upsert reativa e mantém apelido quando o novo vier vazio', async () => {
      const primeira = await concorrente.cadastrarConcorrente({
        empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-2', url: 'https://exemplo.com/anuncio-dup', apelido: 'Nome Original',
      });
      const segunda = await concorrente.cadastrarConcorrente({
        empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-2', url: 'https://exemplo.com/anuncio-dup',
      });
      assert.equal(segunda.id, primeira.id);
      assert.equal(segunda.apelido, 'Nome Original');

      const listados = await concorrente.listarConcorrentesMonitorados({ empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-2' });
      assert.equal(listados.length, 1);
    });

    test('removerConcorrenteMonitorado desativa (nunca apaga) e some da listagem padrão, mas continua visível com incluirInativos', async () => {
      const linha = await concorrente.cadastrarConcorrente({
        empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-3', url: 'https://exemplo.com/anuncio-remover',
      });
      await concorrente.removerConcorrenteMonitorado({ empresaId: EMPRESA_ID_CADASTRO, id: linha.id });

      const ativos = await concorrente.listarConcorrentesMonitorados({ empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-3' });
      assert.equal(ativos.length, 0);

      const todos = await concorrente.listarConcorrentesMonitorados({ empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-3', incluirInativos: true });
      assert.equal(todos.length, 1);
      assert.equal(todos[0].ativo, false);
    });

    test('removerConcorrenteMonitorado com id de outra empresa (ou inexistente) -> erro claro, nunca desativa cadastro de outra empresa', async () => {
      const linha = await concorrente.cadastrarConcorrente({
        empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-4', url: 'https://exemplo.com/anuncio-de-outra-empresa',
      });
      await assert.rejects(
        () => concorrente.removerConcorrenteMonitorado({ empresaId: 999999, id: linha.id }),
        (err) => { assert.equal(err.status, 404); return true; }
      );
      const aindaAtivo = await concorrente.listarConcorrentesMonitorados({ empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-4' });
      assert.equal(aindaAtivo.length, 1);
      assert.equal(aindaAtivo[0].ativo, true);
    });

    test('mapaConcorrentesMonitoradosPorSku agrupa por sku, incluindo mais de um concorrente pro mesmo sku', async () => {
      await concorrente.cadastrarConcorrente({ empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-5', url: 'https://exemplo.com/a' });
      await concorrente.cadastrarConcorrente({ empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-5', url: 'https://exemplo.com/b' });
      await concorrente.cadastrarConcorrente({ empresaId: EMPRESA_ID_CADASTRO, sku: 'CX-6', url: 'https://exemplo.com/c' });

      const mapa = await concorrente.mapaConcorrentesMonitoradosPorSku(EMPRESA_ID_CADASTRO);
      assert.equal(mapa['CX-5'].length, 2);
      assert.equal(mapa['CX-6'].length, 1);
      assert.equal(mapa['CX-7'], undefined);
    });
  }
);
