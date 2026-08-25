// Testes das ferramentas da IA Gestora (lib/ia/ferramentas.js) — ativada em
// 2026, 3 passos pedidos pelo usuário (ver docs/02-decisoes.md).
//
// Parte 1 (sem banco): forma do catálogo de ferramentas (nunca vaza o
// `handler` pro schema que viaja pro provedor de IA) e comportamento de
// `criarContexto`/`executarFerramenta` que não depende de dado real.
//
// Parte 2 (precisa de Postgres local — DATABASE_URL, mesmo padrão dos
// outros *.test.js): cada ferramenta é comparada NÚMERO A NÚMERO contra a
// mesma função de origem que Visão Geral/Pedidos/Financeiro/DRE/Relatórios
// já usam — a prova de que "não existe uma segunda regra financeira criada
// só para a IA" (pedido explícito do usuário). Reaproveita a empresa 900
// (11 pedidos reais já seedados por outros testes) pro que depende de
// venda, e uma empresa nova (970) pro que depende de Contas a Pagar/
// Receber/Estoque.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { FERRAMENTAS_SCHEMA, criarContexto, executarFerramenta } = require('../lib/ia/ferramentas');
const { buscarPedidosDoPeriodo, resumirPeriodo, buscarItensDoPeriodo } = require('../lib/relatorioVendas');
const { gerarDRE } = require('../lib/dre');
const { relatorioProdutos, relatorioMarketplaces } = require('../lib/relatoriosAgregados');
const { resumoContasPagar } = require('../lib/contasPagar');
const { resumoContasReceber } = require('../lib/contasReceber');
const { gerarAlertas, conexoesEEmpresas } = require('../lib/visaoGeralPainel');

describe('ia/ferramentas — catálogo (sem banco)', () => {
  test('FERRAMENTAS_SCHEMA nunca vaza o handler (só name/description/input_schema)', () => {
    assert.ok(FERRAMENTAS_SCHEMA.length >= 9, 'as 9 ferramentas pedidas para cobrir as 12 perguntas de exemplo do usuário');
    FERRAMENTAS_SCHEMA.forEach((f) => {
      assert.equal(Object.keys(f).sort().join(','), 'description,input_schema,name');
      assert.equal(typeof f.name, 'string');
      assert.equal(typeof f.description, 'string');
      assert.equal(f.input_schema.type, 'object');
    });
  });

  test('nomes das ferramentas são únicos', () => {
    const nomes = FERRAMENTAS_SCHEMA.map((f) => f.name);
    assert.equal(new Set(nomes).size, nomes.length);
  });

  test('executarFerramenta com nome desconhecido nunca quebra — devolve erro estruturado', async () => {
    const ctx = criarContexto({ empresaId: 900, periodoChave: '30d' });
    const resultado = await executarFerramenta('ferramenta_que_nao_existe', {}, ctx);
    assert.ok(resultado.erro);
  });

  test('criarContexto nunca deixa o modelo escolher empresa/período — só o que foi passado pelo header', () => {
    const ctx = criarContexto({ empresaId: '900', periodoChave: 'mes' });
    assert.equal(ctx.empresaId, 900); // sempre normalizado pra number
    assert.equal(ctx.periodoCalc.chave, 'mes');
    assert.equal(typeof ctx.desdeStr, 'string');
    assert.equal(typeof ctx.ateStr, 'string');
  });

  test('criarContexto cai no período padrão (30d) pra uma chave inválida — nunca quebra', () => {
    const ctx = criarContexto({ empresaId: 900, periodoChave: 'periodo-que-nao-existe' });
    assert.equal(ctx.periodoCalc.chave, '30d');
  });
});

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_REAL_ID = 900; // já seedada por outros testes (11 pedidos reais)
const EMPRESA_IA_ID = 970;

describe(
  'ia/ferramentas — integração (Postgres real)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado (ver relatorioVendas.integration.test.js)' },
  () => {
    let pool;

    before(async () => {
      pool = require('../db/pool');
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'33333333000191','EMPRESA TESTE IA GESTORA',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_IA_ID]
      );
      await pool.query('DELETE FROM contas_pagar WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM contas_receber WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE empresa_id = $1', [EMPRESA_IA_ID]);

      // Conta a pagar VENCIDA (saldo em aberto — não depende do período).
      await pool.query(
        `INSERT INTO contas_pagar (empresa_id, descricao, categoria, valor, vencimento, status)
         VALUES ($1, 'Fornecedor teste IA', 'Fornecedores', 750.00, '2020-01-01', 'pendente')`,
        [EMPRESA_IA_ID]
      );
      // Conta a receber ATRASADA.
      await pool.query(
        `INSERT INTO contas_receber (empresa_id, descricao, origem, valor, data_prevista, status)
         VALUES ($1, 'Recebível teste IA', 'Outros', 400.00, '2020-01-01', 'a_receber')`,
        [EMPRESA_IA_ID]
      );
      // Conta ML pra alimentar ml_estoque_itens (FK obrigatória).
      await pool.query(
        `INSERT INTO ml_contas (id, empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1,$1,970000001,'LOJA IA TESTE','x','x', now() + interval '6 hours', 'ativa')`,
        [EMPRESA_IA_ID]
      );
      await pool.query(
        `INSERT INTO ml_estoque_itens
           (conta_ml_id, empresa_id, tipo, ml_item_id, ml_variation_id, titulo, sku, loja, status, quantidade, pendente, motivo_pendencia, recurso_usado)
         VALUES
           ($1,$1,'proprio','MLB970-0',NULL,'Item zerado','SKU-IA-ZERADO','LOJA IA TESTE','active',0,FALSE,NULL,'available_quantity'),
           ($1,$1,'proprio','MLB970-1',NULL,'Item estoque baixo','SKU-IA-BAIXO','LOJA IA TESTE','active',2,FALSE,NULL,'available_quantity'),
           ($1,$1,'proprio','MLB970-2',NULL,'Item estoque normal','SKU-IA-NORMAL','LOJA IA TESTE','active',300,FALSE,NULL,'available_quantity'),
           ($1,$1,'full','MLB970-3',NULL,'Item Full','SKU-IA-FULL','LOJA IA TESTE','active',50,FALSE,NULL,'inventory_id')`,
        [EMPRESA_IA_ID]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM contas_pagar WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM contas_receber WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_IA_ID]);
      await pool.end();
    });

    test('resumo_vendas bate número a número com resumirPeriodo (mesma fonte, nenhum cálculo novo)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: '30d' });
      const resultado = await executarFerramenta('resumo_vendas', {}, ctx);
      const { pedidos } = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      const esperado = resumirPeriodo(pedidos);

      assert.equal(resultado.quantidadePedidos, esperado.qtdPedidos);
      assert.equal(resultado.faturamento.valor, esperado.faturamento.valor);
      assert.equal(resultado.margemContribuicao.valor, esperado.margemContribuicao.valor);
      assert.equal(resultado.taxasEComissoesMarketplace.valor, esperado.tarifas.valor);
      assert.equal(resultado.freteDoVendedor.valor, esperado.freteVendedor.valor);
      assert.equal(resultado.custoDosProdutos.valor, esperado.custoProduto.valor);
      assert.equal(resultado.pedidosCancelados.quantidade, esperado.cancelados.quantidade);
    });

    test('resultado_periodo bate número a número com gerarDRE (mesmo demonstrativo da tela DRE)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('resultado_periodo', {}, ctx);
      const esperado = await gerarDRE({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate, desdeBRT: ctx.desdeStr, ateBRT: ctx.ateStr });

      assert.equal(resultado.temPedidoNoPeriodo, esperado.hasOrders);
      assert.equal(resultado.margemContribuicao.valor, esperado.linhas.margemContribuicao.valor);
      assert.equal(resultado.resultadoFinal.valor, esperado.linhas.resultadoFinal.valor);
      assert.equal(resultado.despesasPagasNoPeriodo.valor, esperado.linhas.despesasPeriodo.valor);
    });

    test('produtos_desempenho (lucro) devolve o mesmo topo 1 de relatorioProdutos, ordenado certo', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('produtos_desempenho', { ordenarPor: 'lucro', limite: 3 }, ctx);
      const esperado = await relatorioProdutos({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      const comMargem = esperado.linhas.filter((l) => l.margemContribuicao !== null).sort((a, b) => b.margemContribuicao - a.margemContribuicao);

      assert.ok(resultado.produtos.length <= 3);
      if (comMargem.length) {
        assert.equal(resultado.produtos[0].sku, comMargem[0].sku);
        assert.equal(resultado.produtos[0].margemContribuicao, comMargem[0].margemContribuicao);
      }
      // Nunca ordena decrescente errado.
      for (let i = 1; i < resultado.produtos.length; i++) {
        assert.ok(resultado.produtos[i - 1].margemContribuicao >= resultado.produtos[i].margemContribuicao);
      }
    });

    test('produtos_desempenho (prejuizo) só devolve produtos com margem negativa', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('produtos_desempenho', { ordenarPor: 'prejuizo' }, ctx);
      resultado.produtos.forEach((p) => assert.ok(p.margemContribuicao < 0));
    });

    test('skus_sem_custo bate com o LEFT JOIN de buscarItensDoPeriodo (nunca lê produtos.custo como se pudesse ser null)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('skus_sem_custo', {}, ctx);
      const { itens } = await buscarItensDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      const esperado = new Set(itens.filter((it) => it.sku && it.custoProduto === null).map((it) => it.sku));
      assert.equal(resultado.quantidadeSkusSemCusto, esperado.size);
    });

    test('desempenho_por_loja bate com relatorioMarketplaces', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('desempenho_por_loja', { ordenarPor: 'faturamento' }, ctx);
      const esperado = await relatorioMarketplaces({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      assert.equal(resultado.totalContasComVendaNoPeriodo, esperado.linhas.length);
    });

    test('alertas_operacionais bate com gerarAlertas (mesma central de Visão Geral > Alertas & IA)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('alertas_operacionais', {}, ctx);
      const [pedidosR, itensR, conexoes, cp, cr] = await Promise.all([
        buscarPedidosDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate }),
        buscarItensDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate }),
        conexoesEEmpresas(EMPRESA_REAL_ID),
        resumoContasPagar({ empresaId: EMPRESA_REAL_ID, desde: ctx.desdeStr, ate: ctx.ateStr }),
        resumoContasReceber({ empresaId: EMPRESA_REAL_ID, desde: ctx.desdeStr, ate: ctx.ateStr }),
      ]);
      const esperado = await gerarAlertas({ empresaId: EMPRESA_REAL_ID, pedidos: pedidosR.pedidos, itens: itensR.itens, fluxoCaixa: { contasAPagar: cp, contasAReceber: cr }, conexoes });
      assert.equal(resultado.quantidadeDeAlertas, esperado.length);
      assert.deepEqual(resultado.alertas.map((a) => a.tipo).sort(), esperado.map((a) => a.tipo).sort());
    });

    test('contas_a_pagar_resumo: conta vencida cadastrada aparece certa (saldo em aberto, independe do período)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_IA_ID, periodoChave: 'hoje' });
      const resultado = await executarFerramenta('contas_a_pagar_resumo', {}, ctx);
      assert.equal(resultado.totalAPagarEmAberto.valor, 750);
      assert.equal(resultado.vencidas.valor, 750);
      assert.equal(resultado.pagoNoPeriodoSelecionado.valor, 0, 'nada foi pago no período — zero de verdade, nunca pendente');
    });

    test('contas_a_receber_resumo: recebível atrasado cadastrado aparece certo', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_IA_ID, periodoChave: 'hoje' });
      const resultado = await executarFerramenta('contas_a_receber_resumo', {}, ctx);
      assert.equal(resultado.totalAReceberEmAberto.valor, 400);
      assert.equal(resultado.atrasado.valor, 400);
    });

    test('estoque_resumo: zerado/baixo/normal contados certo, Full nunca somado com fora do Full', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_IA_ID, periodoChave: 'hoje' });
      const resultado = await executarFerramenta('estoque_resumo', {}, ctx);
      assert.equal(resultado.foraDoFull.totalAnuncios, 3);
      assert.equal(resultado.foraDoFull.anunciosComEstoqueZerado, 1);
      assert.equal(resultado.foraDoFull.anunciosComEstoqueMuitoBaixo, 1);
      assert.equal(resultado.foraDoFull.unidadesDisponiveis, 302); // 0 + 2 + 300
      assert.equal(resultado.full.totalAnuncios, 1);
      assert.equal(resultado.full.unidadesDisponiveis, 50);
    });

    test('empresa sem nenhum pedido no período: resumo_vendas nunca inventa (temPedidoNoPeriodo=false, valores null com 0 pendências)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_IA_ID, periodoChave: 'hoje' });
      const resultado = await executarFerramenta('resumo_vendas', {}, ctx);
      assert.equal(resultado.temPedidoNoPeriodo, false);
      assert.equal(resultado.faturamento.valor, null);
      assert.equal(resultado.faturamento.pedidosSemEssaInformacao, 0, 'período vazio não é a mesma coisa que dado pendente');
    });
  }
);
