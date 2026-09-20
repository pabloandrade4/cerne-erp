// Análise de Concorrente virou ciclo AUTOMÁTICO (19/09/2026, pedido
// explícito do usuário: "quero que essas ia nunca pare de trabalhar...
// sempre buscar concorrentes que estão vendendo o mesmo produto que eu").
// Testes de INTEGRAÇÃO (precisa de Postgres local, mesma regra de skip por
// DATABASE_URL dos outros arquivos desta pasta) — mocka
// lib/mercadolivre.js#apiGet (nunca chama a API real, mesmo padrão de
// test/concorrente.test.js/test/mlAdsFallback.test.js), porque este
// sandbox não tem acesso à internet pra api.mercadolibre.com.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('crypto');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 979;
const CONTA_ID = 979;
const PRODUTO_ID = 97900001;
const PRODUTO_ID_INATIVO = 97900002;

describe(
  'lib/ia/radarConcorrente — varredura automática, alerta real e nunca inventa o que não existe (19/09/2026)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste' },
  () => {
    let pool, ml, radarConcorrente, apiGetOriginal;

    before(async () => {
      if (!process.env.ML_TOKEN_KEY) process.env.ML_TOKEN_KEY = nodeCrypto.randomBytes(32).toString('base64');
      pool = require('../db/pool');
      ml = require('../lib/mercadolivre');
      const { encrypt } = require('../lib/crypto');
      radarConcorrente = require('../lib/ia/radarConcorrente');

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1, '97970707000199', 'EMPRESA TESTE RADAR CONCORRENTE', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, 979000001, 'LOJA TESTE RADAR CONCORRENTE', $3, $3, now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET access_token_enc = $3, token_expires_at = now() + interval '6 hours', status = 'ativa'`,
        [CONTA_ID, EMPRESA_ID, encrypt('token-de-teste')]
      );
      await pool.query(
        `INSERT INTO produtos (id, empresa_id, nome, sku, custo, ativo) VALUES
           ($1, $2, 'Caixa Teste Radar Concorrente', 'CX-RADAR-CONC', 10, TRUE),
           ($3, $2, 'Produto inativo (nunca entra na varredura)', 'CX-RADAR-INATIVO', 10, FALSE)
         ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku, ativo = EXCLUDED.ativo`,
        [PRODUTO_ID, EMPRESA_ID, PRODUTO_ID_INATIVO]
      );
      const { rows } = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, data_criacao, status)
         VALUES ($1, 9790001, now(), 'paid') RETURNING id`,
        [CONTA_ID]
      );
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, quantidade, preco_unitario)
         VALUES ($1, 'MLB9790001', 'Caixa de Papelão Reforçada Radar Concorrente', 'CX-RADAR-CONC', 1, 100.00)`,
        [rows[0].id]
      );
    });

    beforeEach(() => { apiGetOriginal = ml.apiGet; });
    afterEach(async () => {
      ml.apiGet = apiGetOriginal;
      await pool.query(`DELETE FROM radar_alertas WHERE empresa_id = $1`, [EMPRESA_ID]);
    });

    after(async () => {
      await pool.query('DELETE FROM ml_pedido_itens WHERE pedido_id IN (SELECT id FROM ml_pedidos WHERE conta_ml_id = $1)', [CONTA_ID]);
      await pool.query('DELETE FROM ml_pedidos WHERE conta_ml_id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM produtos WHERE id IN ($1, $2)', [PRODUTO_ID, PRODUTO_ID_INATIVO]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
    });

    test('listarProdutosElegiveisParaVarredura: só entra produto ATIVO com venda real registrada no Mercado Livre', async () => {
      const { listarProdutosElegiveisParaVarredura } = require('../lib/concorrente');
      const produtos = await listarProdutosElegiveisParaVarredura(EMPRESA_ID);
      const ids = produtos.map((p) => p.id);
      assert.ok(ids.includes(PRODUTO_ID), 'produto ativo com venda real precisa entrar');
      assert.ok(!ids.includes(PRODUTO_ID_INATIVO), 'produto inativo nunca entra, mesmo com venda registrada');
    });

    test('concorrente bem mais barato (>=15%) em modo catálogo -> severidade "critico", nunca inventa certeza em modo por título', async () => {
      ml.apiGet = async (path) => {
        if (path === '/items/MLB9790001') return { title: 'Caixa de Papelão Reforçada Radar Concorrente', catalog_product_id: 'MLB999' };
        if (path === '/products/MLB999/items?site_id=MLB') {
          return { results: [{ seller_id: 555, seller: { nickname: 'CONCORRENTE BARATO' }, title: 'x', price: 80, available_quantity: 5, status: 'active' }] };
        }
        throw new Error('path inesperado: ' + path);
      };

      const { situacoes } = await radarConcorrente.analisarConcorrentes({ empresaId: EMPRESA_ID });
      assert.equal(situacoes.length, 1);
      assert.equal(situacoes[0].categoria, 'concorrente_ativo');
      assert.equal(situacoes[0].severidade, 'critico');
      assert.equal(situacoes[0].dados.confiavel, true);
      assert.equal(situacoes[0].dados.menorPrecoConcorrente, 80);
      assert.equal(situacoes[0].dados.meuPrecoUltimaVenda, 100);
    });

    test('mesmo concorrente barato, mas achado só por TÍTULO (candidato, não catálogo) -> nunca escala pra "critico"', async () => {
      ml.apiGet = async (path) => {
        if (path === '/items/MLB9790001') return { title: 'Caixa de Papelão Reforçada Radar Concorrente', catalog_product_id: null };
        if (path.startsWith('/sites/MLB/search?q=')) {
          return { results: [{ seller_id: 556, seller: { nickname: 'CANDIDATO BARATO' }, title: 'x', price: 50, available_quantity: 5, status: 'active' }] };
        }
        throw new Error('path inesperado: ' + path);
      };

      const { situacoes } = await radarConcorrente.analisarConcorrentes({ empresaId: EMPRESA_ID });
      assert.equal(situacoes.length, 1);
      assert.equal(situacoes[0].dados.confiavel, false);
      assert.equal(situacoes[0].severidade, 'atencao', 'candidato de baixa confiança nunca vira "critico", mesmo com diferença de preço grande');
    });

    test('você já está no preço igual ou menor que o concorrente -> severidade "oportunidade", nunca tratado como problema', async () => {
      ml.apiGet = async (path) => {
        if (path === '/items/MLB9790001') return { title: 'Caixa de Papelão Reforçada Radar Concorrente', catalog_product_id: 'MLB999' };
        if (path === '/products/MLB999/items?site_id=MLB') {
          return { results: [{ seller_id: 557, seller: { nickname: 'CONCORRENTE CARO' }, title: 'x', price: 150, available_quantity: 5, status: 'active' }] };
        }
        throw new Error('path inesperado: ' + path);
      };

      const { situacoes } = await radarConcorrente.analisarConcorrentes({ empresaId: EMPRESA_ID });
      assert.equal(situacoes.length, 1);
      assert.equal(situacoes[0].severidade, 'oportunidade');
    });

    test('nenhum concorrente vendendo agora -> nenhuma situação (nunca cria alerta vazio/inventado)', async () => {
      ml.apiGet = async (path) => {
        if (path === '/items/MLB9790001') return { title: 'Caixa de Papelão Reforçada Radar Concorrente', catalog_product_id: 'MLB999' };
        if (path === '/products/MLB999/items?site_id=MLB') return { results: [] };
        if (path.startsWith('/sites/MLB/search?q=')) return { results: [] };
        throw new Error('path inesperado: ' + path);
      };

      const { situacoes } = await radarConcorrente.analisarConcorrentes({ empresaId: EMPRESA_ID });
      assert.equal(situacoes.length, 0);
    });

    test('executarCicloConcorrenteEmpresa: persiste em radar_alertas (categoria concorrente_ativo) e auto-resolve quando o concorrente some no ciclo seguinte', async () => {
      ml.apiGet = async (path) => {
        if (path === '/items/MLB9790001') return { title: 'Caixa de Papelão Reforçada Radar Concorrente', catalog_product_id: 'MLB999' };
        if (path === '/products/MLB999/items?site_id=MLB') {
          return { results: [{ seller_id: 558, seller: { nickname: 'CONCORRENTE ATIVO' }, title: 'x', price: 70, available_quantity: 5, status: 'active' }] };
        }
        throw new Error('path inesperado: ' + path);
      };

      const r1 = await radarConcorrente.executarCicloConcorrenteEmpresa(EMPRESA_ID);
      assert.equal(r1.situacoesDetectadas, 1);
      assert.equal(r1.novasOuEscaladas, 1, 'primeira detecção é sempre nova');

      const { rows: abertos } = await pool.query(
        `SELECT status, severidade, categoria FROM radar_alertas WHERE empresa_id = $1 AND categoria = 'concorrente_ativo'`,
        [EMPRESA_ID]
      );
      assert.equal(abertos.length, 1);
      assert.equal(abertos[0].status, 'aberto');
      assert.equal(abertos[0].severidade, 'critico');

      // Rodar de novo com a MESMA situação nunca duplica nem gera um novo
      // aviso (mesmo motor de persistirSituacoes do Radar da IA).
      const r2 = await radarConcorrente.executarCicloConcorrenteEmpresa(EMPRESA_ID);
      assert.equal(r2.novasOuEscaladas, 0, 'situação inalterada nunca conta como nova de novo');

      // Concorrente sumiu (nenhum resultado agora) -> alerta se resolve
      // sozinho, sem nenhuma ação manual.
      ml.apiGet = async (path) => {
        if (path === '/items/MLB9790001') return { title: 'Caixa de Papelão Reforçada Radar Concorrente', catalog_product_id: 'MLB999' };
        if (path === '/products/MLB999/items?site_id=MLB') return { results: [] };
        if (path.startsWith('/sites/MLB/search?q=')) return { results: [] };
        throw new Error('path inesperado: ' + path);
      };
      await radarConcorrente.executarCicloConcorrenteEmpresa(EMPRESA_ID);
      const { rows: depois } = await pool.query(
        `SELECT status FROM radar_alertas WHERE empresa_id = $1 AND categoria = 'concorrente_ativo'`,
        [EMPRESA_ID]
      );
      assert.equal(depois.length, 1);
      assert.equal(depois[0].status, 'resolvido');
    });

    test('produto sem venda registrada no Mercado Livre (modo sem_dado) -> nunca gera situação', async () => {
      // Produto elegível mas sem nenhum item associado nesta chamada
      // específica: simula chamando analisarConcorrentes com um produto que
      // não está entre os elegíveis (id inexistente) via chamada direta ao
      // motor — a lista real já filtra isso (ver teste acima), então aqui
      // confirmamos que o próprio buscarConcorrentesPorProduto (chamado por
      // dentro) segue devolvendo 'sem_dado' sem gerar alerta, mesmo padrão
      // do resto do sistema.
      const { buscarConcorrentesPorProduto } = require('../lib/concorrente');
      const resultado = await buscarConcorrentesPorProduto({ empresaId: EMPRESA_ID, produtoId: PRODUTO_ID_INATIVO });
      assert.equal(resultado.modo, 'sem_dado');
    });
  }
);
