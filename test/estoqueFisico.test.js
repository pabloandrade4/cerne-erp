// Teste de INTEGRAÇÃO (precisa de Postgres local — DATABASE_URL, mesmo
// padrão dos outros arquivos *.integration.test.js) de
// lib/estoqueFisico.js#calcularEstoqueFisico — usado pela nova tela
// Estoque Full (19/09/2026, pedido explícito do usuário: mostrar valor em
// R$, quantidade em caixas e a quebra por modelo/SKU, tudo separado, em vez
// dos anúncios crus). Este módulo já existia (criado para a IA Gestora),
// mas nunca tinha teste próprio — como ele virou peça central de uma tela
// real agora, ganha cobertura direta aqui.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 960;
const CONTA_ML_ID = 960;

describe(
  'lib/estoqueFisico.js#calcularEstoqueFisico',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool, calcularEstoqueFisico;
    let produtoBaseComCustoId, produtoBaseSemCustoId;

    before(async () => {
      pool = require('../db/pool');
      ({ calcularEstoqueFisico } = require('../lib/estoqueFisico'));

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'88888888000191','EMPRESA TESTE ESTOQUE FISICO',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$2,960000001,'LOJA ESTOQUE FISICO TESTE','x','x', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status='ativa'`,
        [CONTA_ML_ID, EMPRESA_ID]
      );

      await pool.query('DELETE FROM produto_base_skus WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM produtos_base WHERE empresa_id = $1', [EMPRESA_ID]);

      const { rows: r1 } = await pool.query(
        `INSERT INTO produtos_base (empresa_id, codigo, nome, custo, ativo) VALUES ($1,'CX-19X12X12','Caixa 19x12x12',0.91,TRUE) RETURNING id`,
        [EMPRESA_ID]
      );
      produtoBaseComCustoId = r1[0].id;

      const { rows: r2 } = await pool.query(
        `INSERT INTO produtos_base (empresa_id, codigo, nome, custo, ativo) VALUES ($1,'CX-20X20X20','Caixa 20x20x20',NULL,TRUE) RETURNING id`,
        [EMPRESA_ID]
      );
      produtoBaseSemCustoId = r2[0].id;

      // Vínculo SALVO (prioridade sobre a heurística do texto do SKU) —
      // '100CX-19X12X12' aponta pra CX-19X12X12, multiplicador 100.
      await pool.query(
        `INSERT INTO produto_base_skus (empresa_id, sku, produto_base_id, multiplicador, origem)
         VALUES ($1,'100CX-19X12X12',$2,100,'manual')`,
        [EMPRESA_ID, produtoBaseComCustoId]
      );

      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query(
        `INSERT INTO ml_estoque_itens
           (conta_ml_id, empresa_id, tipo, ml_item_id, ml_variation_id, titulo, sku, loja, status, quantidade, pendente, motivo_pendencia, recurso_usado)
         VALUES
           -- Full, SKU com vínculo salvo e produto base COM custo: 2 anúncios
           -- disponíveis x 100 (multiplicador) = 200 caixas físicas.
           ($1,$2,'full','MLB-FULL-1',NULL,'Caixa 19x12x12 (Full)','100CX-19X12X12','LOJA ESTOQUE FISICO TESTE','active',2,FALSE,NULL,'full_inventory'),
           -- Full, SKU SEM vínculo salvo mas que a heurística resolve
           -- ('20CX-20X20X20' -> CX-20X20X20, multiplicador 20) — produto
           -- base SEM custo cadastrado: entra na quantidade em caixas, não
           -- no valor.
           ($1,$2,'full','MLB-FULL-2',NULL,'Caixa 20x20x20 (Full)','20CX-20X20X20','LOJA ESTOQUE FISICO TESTE','active',3,FALSE,NULL,'full_inventory'),
           -- Full, SKU que não bate com nenhum produto base e não segue o
           -- padrão heurístico — nunca chuta, fica "sem produto base".
           ($1,$2,'full','MLB-FULL-3',NULL,'Item sem produto base','SKU-QUALQUER','LOJA ESTOQUE FISICO TESTE','active',5,FALSE,NULL,'full_inventory'),
           -- Full, pendente (API não retornou quantidade) — nunca inventa,
           -- só conta como pendente.
           ($1,$2,'full','MLB-FULL-4',NULL,'Item pendente Full',NULL,'LOJA ESTOQUE FISICO TESTE','active',NULL,TRUE,'sem_dado_na_api',NULL),
           -- Fora do Full — nunca pode entrar no bloco "full".
           ($1,$2,'proprio','MLB-PROPRIO-1',NULL,'Caixa 19x12x12 (fora do Full)','100CX-19X12X12','LOJA ESTOQUE FISICO TESTE','active',1,FALSE,NULL,'available_quantity')`,
        [CONTA_ML_ID, EMPRESA_ID]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM produto_base_skus WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM produtos_base WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      await pool.end();
    });

    test('nunca soma/mistura Full com fora do Full', async () => {
      const r = await calcularEstoqueFisico(EMPRESA_ID);
      assert.equal(r.full.itens.filter((i) => i.itemId === 'MLB-PROPRIO-1').length, 0);
      assert.equal(r.foraDoFull.itens.filter((i) => i.itemId === 'MLB-FULL-1').length, 0);
    });

    test('converte kit -> físico usando o vínculo salvo (produto_base_skus), com custo cadastrado', async () => {
      const r = await calcularEstoqueFisico(EMPRESA_ID);
      const item = r.full.itens.find((i) => i.itemId === 'MLB-FULL-1');
      assert.ok(item, 'item MLB-FULL-1 deveria estar em full.itens');
      assert.equal(item.produtoBase, 'CX-19X12X12');
      assert.equal(item.quantidadeDisponivel, 2);
      assert.equal(item.quantidadeFisica, 200, '2 anúncios x multiplicador 100 = 200 caixas');
      assert.equal(item.custoUnitario, 0.91);
      assert.equal(item.valorEmEstoque, 182, '200 x 0.91 = 182');
    });

    test('SKU sem vínculo salvo, mas resolvido pela heurística do texto — produto base sem custo entra na quantidade, não no valor', async () => {
      const r = await calcularEstoqueFisico(EMPRESA_ID);
      const item = r.full.itens.find((i) => i.itemId === 'MLB-FULL-2');
      assert.ok(item);
      assert.equal(item.produtoBase, 'CX-20X20X20');
      assert.equal(item.quantidadeFisica, 60, '3 anúncios x multiplicador 20 = 60 caixas');
      assert.equal(item.custoUnitario, null, 'nunca inventa um custo — produto base não tem custo cadastrado');
      assert.equal(item.valorEmEstoque, null);
      assert.equal(r.full.unidadesFisicasSemCustoCadastrado, 60);
    });

    test('SKU que não bate com nenhum produto base (nem heurística) nunca é chutado', async () => {
      const r = await calcularEstoqueFisico(EMPRESA_ID);
      const item = r.full.itens.find((i) => i.itemId === 'MLB-FULL-3');
      assert.ok(item);
      assert.equal(item.produtoBase, null);
      assert.equal(item.quantidadeFisica, null);
      assert.equal(r.full.unidadesSemProdutoBaseIdentificado, 5);
    });

    test('item pendente (API não retornou quantidade) nunca vira um número inventado', async () => {
      const r = await calcularEstoqueFisico(EMPRESA_ID);
      assert.equal(r.full.itens.filter((i) => i.itemId === 'MLB-FULL-4').length, 0, 'pendente não entra na lista de itens processados');
      assert.equal(r.full.itensPendentesDeSincronizacao, 1);
    });

    test('valorTotalACusto do bloco Full soma só os itens com custo cadastrado', async () => {
      const r = await calcularEstoqueFisico(EMPRESA_ID);
      assert.equal(r.full.valorTotalACusto, 182, 'só MLB-FULL-1 tem produto base com custo; os outros ficam de fora da soma');
      assert.equal(r.full.unidadesFisicas, 200 + 60, 'quantidade física soma só quem tem produto base identificado (com ou sem custo) — o item sem produto base (5) fica de fora, em unidadesSemProdutoBaseIdentificado');
    });

    test('agrega por produto base (produtosBase) corretamente', async () => {
      const r = await calcularEstoqueFisico(EMPRESA_ID);
      const modelo1 = r.full.produtosBase.find((p) => p.produtoBase === 'CX-19X12X12');
      assert.equal(modelo1.quantidadeFisica, 200);
      assert.equal(modelo1.valorEmEstoque, 182);
      const modelo2 = r.full.produtosBase.find((p) => p.produtoBase === 'CX-20X20X20');
      assert.equal(modelo2.quantidadeFisica, 60);
      assert.equal(modelo2.valorEmEstoque, null);
    });

    test('valorTotalGeral soma Full + fora do Full quando ambos têm valor', async () => {
      const r = await calcularEstoqueFisico(EMPRESA_ID);
      // foraDoFull tem só MLB-PROPRIO-1 (mesmo SKU/produto base com custo) — 1 x 100 x 0.91 = 91.
      assert.equal(r.foraDoFull.valorTotalACusto, 91);
      assert.equal(r.valorTotalGeral, 182 + 91);
    });

    test('empresa sem nenhum item em ml_estoque_itens devolve blocos vazios, nunca inventa', async () => {
      const r = await calcularEstoqueFisico(999999);
      assert.equal(r.full.valorTotalACusto, null);
      assert.equal(r.full.unidadesFisicas, 0);
      assert.deepEqual(r.full.itens, []);
      assert.equal(r.valorTotalGeral, null);
    });
  }
);
