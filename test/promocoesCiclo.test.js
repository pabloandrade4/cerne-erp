// IA de Promoções — Fase B — testes de INTEGRAÇÃO (precisa de Postgres
// local — mesma regra de skip por DATABASE_URL dos outros arquivos desta
// pasta, ver test/radar.test.js). Cobre o contrato de resiliência do ciclo
// automático (lib/ia/promocoesCiclo.js), disparando-o como uma função Node
// comum — exatamente como lib/ia/promocoesScheduler.js dispara sozinho, sem
// depender de nenhuma aba aberta:
//   1) empresa inexistente/inativa é ignorada, nunca derruba o ciclo;
//   2) empresa sem nenhuma conta ativa simplesmente não analisa nada (não é
//      erro);
//   3) uma conta com token inválido (não dá pra chamar a API do Mercado
//      Livre de verdade) faz o ciclo registrar o erro DAQUELA conta e
//      seguir — nunca lança exceção pra fora nem derruba o processo. Esta
//      suíte não chama a API real do Mercado Livre (mesma decisão já usada
//      em test/radar.test.js para a API de Ads: token fabricado, sem
//      credencial válida).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 971;
const EMPRESA_SEM_CONTA_ID = 972;
const CONTA_ML_ID = 971;

describe(
  'IA de Promoções — ciclo automático (Fase B): resiliência por empresa/conta',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste (ver topo de relatorioVendas.integration.test.js)' },
  () => {
    let pool;
    let executarCicloPromocoesEmpresa;
    let buscarEstoqueAtualPorSku;
    let upsertAnalise;

    before(async () => {
      pool = require('../db/pool');
      ({ executarCicloPromocoesEmpresa, buscarEstoqueAtualPorSku, upsertAnalise } = require('../lib/ia/promocoesCiclo'));

      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
           ($1, '97170707000199', 'EMPRESA TESTE PROMOÇÕES', TRUE),
           ($2, '97270707000199', 'EMPRESA TESTE PROMOÇÕES SEM CONTA', TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID, EMPRESA_SEM_CONTA_ID]
      );
      // Token fabricado (não é um access_token real do Mercado Livre) —
      // qualquer chamada à API vai falhar com erro de autenticação, o que é
      // exatamente o cenário que este teste quer confirmar que o ciclo
      // sabe absorver sem derrubar o processo.
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, 971000001, 'LOJA TESTE PROMOÇÕES', 'token-invalido', 'refresh-invalido', now() + interval '6 hours', 'ativa')
         ON CONFLICT (id) DO UPDATE SET status = 'ativa'`,
        [CONTA_ML_ID, EMPRESA_ID]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM promocoes_analises WHERE empresa_id = ANY($1::int[])', [[EMPRESA_ID, EMPRESA_SEM_CONTA_ID]]);
      await pool.query('DELETE FROM ml_contas WHERE id = $1', [CONTA_ML_ID]);
      await pool.query('DELETE FROM empresas WHERE id = ANY($1::int[])', [[EMPRESA_ID, EMPRESA_SEM_CONTA_ID]]);
    });

    test('empresa inexistente: devolve ignorado, nunca lança exceção', async () => {
      const resultado = await executarCicloPromocoesEmpresa(999999);
      assert.equal(resultado.ignorado, true);
    });

    test('empresa ativa sem nenhuma conta do Mercado Livre: não analisa nada, não é erro', async () => {
      const resultado = await executarCicloPromocoesEmpresa(EMPRESA_SEM_CONTA_ID);
      assert.equal(resultado.contasProcessadas, 0);
      assert.equal(resultado.itensAnalisados, 0);
    });

    test('conta com token inválido: o ciclo termina normalmente e registra o erro DAQUELA conta', async () => {
      const resultado = await executarCicloPromocoesEmpresa(EMPRESA_ID);
      assert.equal(resultado.contasProcessadas, 1);
      assert.equal(resultado.itensAnalisados, 0);
      assert.equal(resultado.comErro.length, 1);
      assert.equal(resultado.comErro[0].contaId, CONTA_ML_ID);
      assert.ok(resultado.comErro[0].erro && resultado.comErro[0].erro.length > 0);
    });

    // 20/09/2026 — "estoque alto" (pedido explícito do usuário): confirma
    // que a soma vem da MESMA tabela/fonte real da tela Estoque
    // (ml_estoque_itens), nunca uma segunda sincronização própria daqui, e
    // que linha "pendente" nunca entra na soma (quantidade não confiável).
    describe('buscarEstoqueAtualPorSku — soma o estoque real por SKU a partir de ml_estoque_itens', () => {
      after(async () => {
        await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_ID]);
      });

      test('soma quantidade de itens próprio+full do mesmo SKU, ignora pendente e SKU nulo', async () => {
        await pool.query(
          `INSERT INTO ml_estoque_itens (conta_ml_id, empresa_id, tipo, ml_item_id, sku, quantidade, pendente)
           VALUES
             ($1, $2, 'proprio', 'MLB-EST-1', 'SKU-EST-1', 30, FALSE),
             ($1, $2, 'full', 'MLB-EST-2', 'SKU-EST-1', 20, FALSE),
             ($1, $2, 'proprio', 'MLB-EST-3', 'SKU-EST-1', 999, TRUE),
             ($1, $2, 'proprio', 'MLB-EST-4', NULL, 50, FALSE)`,
          [CONTA_ML_ID, EMPRESA_ID]
        );
        const mapa = await buscarEstoqueAtualPorSku(EMPRESA_ID);
        assert.equal(mapa.get('SKU-EST-1'), 50); // 30 + 20, nunca soma a linha pendente (999)
        assert.equal(mapa.has('SKU-EST-4'), false);
      });

      test('empresa sem nenhum item de estoque sincronizado: mapa vazio (nunca assume zero pra um SKU que não está lá)', async () => {
        const mapa = await buscarEstoqueAtualPorSku(EMPRESA_SEM_CONTA_ID);
        assert.equal(mapa.size, 0);
      });
    });

    // Confirma que os 4 novos campos de estoque (upsertAnalise, 20/09/2026)
    // são de fato persistidos e recuperáveis em promocoes_analises — nunca
    // só passados adiante sem gravar.
    describe('upsertAnalise — grava e atualiza os campos de estoque alto', () => {
      const linhaBase = {
        empresaId: EMPRESA_ID, contaId: CONTA_ML_ID, promotionId: 'PROMO-EST-1', promotionType: 'DEAL', promotionLabel: 'Teste Estoque',
        mlItemId: 'MLB-ANALISE-EST-1', statusItemMl: 'candidate', titulo: 'Produto Teste Estoque', imagemUrl: null, sku: 'SKU-ANALISE-EST',
        precoNormal: 100, precoPromo: 90, origemPrecoPromo: 'price',
        descontoPct: 10, descontoBancadoMeliPct: null, descontoBancadoVendedorPct: 10,
        custoProduto: 30, tarifasEstimadas: 9, freteVendedorEstimado: 8, impostoEstimado: 0,
        margemReal: 43, margemRealPct: 47.78, margemNormalPct: 50, margemMinimaPctUsada: 14,
        margemConfortoPctUsada: 0, temDesconto: true, margemIncompleta: false, motivoIncompleto: null,
        estoqueAtual: 200, unidadesVendidas90d: 10, coberturaDiasEstoque: 90, estoqueAlto: true,
        classificacaoCodigo: 'entrar', classificacaoLabel: 'ENTRAR',
      };

      after(async () => {
        await pool.query('DELETE FROM promocoes_analises WHERE conta_id = $1 AND promotion_id = $2', [CONTA_ML_ID, 'PROMO-EST-1']);
      });

      test('insere com os campos de estoque preenchidos', async () => {
        await upsertAnalise(linhaBase);
        const { rows } = await pool.query(
          `SELECT estoque_atual, vendas_unidades_90d, cobertura_dias_estoque, estoque_alto
             FROM promocoes_analises WHERE conta_id = $1 AND promotion_id = $2 AND ml_item_id = $3`,
          [CONTA_ML_ID, 'PROMO-EST-1', 'MLB-ANALISE-EST-1']
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].estoque_atual, 200);
        assert.equal(rows[0].vendas_unidades_90d, 10);
        assert.equal(Number(rows[0].cobertura_dias_estoque), 90);
        assert.equal(rows[0].estoque_alto, true);
      });

      test('upsert (mesma chave conta+promoção+item): atualiza os campos de estoque em vez de duplicar', async () => {
        await upsertAnalise({ ...linhaBase, estoqueAtual: 5, unidadesVendidas90d: 40, coberturaDiasEstoque: 11.25, estoqueAlto: false });
        const { rows } = await pool.query(
          `SELECT estoque_atual, estoque_alto FROM promocoes_analises WHERE conta_id = $1 AND promotion_id = $2 AND ml_item_id = $3`,
          [CONTA_ML_ID, 'PROMO-EST-1', 'MLB-ANALISE-EST-1']
        );
        assert.equal(rows.length, 1); // nunca duplica
        assert.equal(rows[0].estoque_atual, 5);
        assert.equal(rows[0].estoque_alto, false);
      });
    });
  }
);
