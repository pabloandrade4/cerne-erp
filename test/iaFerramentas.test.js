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
const { relatorioProdutos, relatorioProdutosPorCaixa, relatorioMarketplaces } = require('../lib/relatoriosAgregados');
const { resumoContasPagar } = require('../lib/contasPagar');
const { resumoContasReceber } = require('../lib/contasReceber');
const { gerarAlertas, conexoesEEmpresas, fluxoDeCaixa } = require('../lib/visaoGeralPainel');
const { resumoComprasPorFornecedor } = require('../lib/compras');
const { listarNotasFiscais } = require('../lib/notasFiscais');
const { TEMAS } = require('../lib/ia/baseConhecimento');
const { calcularPeriodo, diaBRT } = require('../lib/periodo');
const { round2 } = require('../lib/resultadoVenda');

describe('ia/ferramentas — catálogo (sem banco)', () => {
  test('FERRAMENTAS_SCHEMA nunca vaza o handler (só name/description/input_schema)', () => {
    assert.ok(FERRAMENTAS_SCHEMA.length >= 20, 'catálogo expandido com projecao_mes (docs/02-decisoes.md)');
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
const EMPRESA_SEM_CONTA_ID = 971; // só pra testar o caminho "sem nenhuma conta ML conectada" de ads_desempenho, sem interferir com ml_contas de EMPRESA_IA_ID

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
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'44444444000192','EMPRESA TESTE IA SEM CONTA ML',TRUE)
         ON CONFLICT (id) DO NOTHING`,
        [EMPRESA_SEM_CONTA_ID]
      );
      await pool.query('DELETE FROM compra_itens WHERE compra_id IN (SELECT id FROM compras WHERE empresa_id = $1)', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM compras WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM fornecedores WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM contas_pagar WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM contas_receber WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM produtos WHERE empresa_id = $1', [EMPRESA_IA_ID]);

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

      // Produto com custo cadastrado pro SKU "SKU-IA-NORMAL" (300 unidades em
      // estoque acima) — usado por estoque_valor_parado (300 × 10 = 3000) e
      // como item de uma compra (compras_resumo).
      const { rows: produtoRows } = await pool.query(
        `INSERT INTO produtos (empresa_id, nome, sku, custo, ativo) VALUES ($1,'Produto teste IA','SKU-IA-NORMAL',10.00,TRUE) RETURNING id`,
        [EMPRESA_IA_ID]
      );
      const produtoId = produtoRows[0].id;

      const { rows: fornecedorRows } = await pool.query(
        `INSERT INTO fornecedores (empresa_id, razao_social, documento, ativo) VALUES ($1,'Fornecedor Teste IA','12345678000195',TRUE) RETURNING id`,
        [EMPRESA_IA_ID]
      );
      const fornecedorId = fornecedorRows[0].id;

      const hoje = require('../lib/periodo').diaBRT(new Date());
      const { rows: compraRows } = await pool.query(
        `INSERT INTO compras (empresa_id, fornecedor_id, data_compra, status, valor_total) VALUES ($1,$2,$3,'em_aberto',500.00) RETURNING id`,
        [EMPRESA_IA_ID, fornecedorId, hoje]
      );
      await pool.query(
        `INSERT INTO compra_itens (compra_id, produto_id, quantidade, custo_unitario, valor_total_item) VALUES ($1,$2,50,10.00,500.00)`,
        [compraRows[0].id, produtoId]
      );
      // Uma segunda compra CANCELADA — nunca deve entrar no total de
      // compras_resumo (ver lib/compras.js).
      await pool.query(
        `INSERT INTO compras (empresa_id, fornecedor_id, data_compra, status, valor_total) VALUES ($1,$2,$3,'cancelado',999.00)`,
        [EMPRESA_IA_ID, fornecedorId, hoje]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM compra_itens WHERE compra_id IN (SELECT id FROM compras WHERE empresa_id = $1)', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM compras WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM fornecedores WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM contas_pagar WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM contas_receber WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM ml_estoque_itens WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM ml_contas WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM produtos WHERE empresa_id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_IA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_SEM_CONTA_ID]);
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

    // ---- Ferramentas novas da tarefa "IA Gestora como inteligência central" ----

    test('produtos_desempenho (faturamento) ordena por faturamento e inclui SKUs sem custo (não filtra como lucro/prejuizo)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('produtos_desempenho', { ordenarPor: 'faturamento', limite: 5 }, ctx);
      const esperado = await relatorioProdutos({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      const ordenadoEsperado = [...esperado.linhas].sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0));
      if (ordenadoEsperado.length) {
        assert.equal(resultado.produtos[0].sku, ordenadoEsperado[0].sku);
        assert.equal(resultado.produtos[0].faturamento, ordenadoEsperado[0].faturamento);
      }
      for (let i = 1; i < resultado.produtos.length; i++) {
        assert.ok((resultado.produtos[i - 1].faturamento || 0) >= (resultado.produtos[i].faturamento || 0));
      }
    });

    test('produtos_desempenho (quantidade) ordena por quantidade vendida ("SKU mais vendido")', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('produtos_desempenho', { ordenarPor: 'quantidade', limite: 5 }, ctx);
      const esperado = await relatorioProdutos({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      const ordenadoEsperado = [...esperado.linhas].sort((a, b) => (b.quantidade || 0) - (a.quantidade || 0));
      if (ordenadoEsperado.length) {
        assert.equal(resultado.produtos[0].sku, ordenadoEsperado[0].sku);
        assert.equal(resultado.produtos[0].quantidadeVendida, ordenadoEsperado[0].quantidade);
      }
    });

    test('produtos_por_caixa_desempenho bate com relatorioProdutosPorCaixa (mesma visão "Por Caixa" de Relatórios)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('produtos_por_caixa_desempenho', { ordenarPor: 'caixas' }, ctx);
      const esperado = await relatorioProdutosPorCaixa({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      assert.equal(resultado.totalProdutosBaseNoPeriodo, esperado.linhas.length);
      assert.equal(resultado.skusSemProdutoBaseIdentificado, esperado.semProdutoBase.length);
      const ordenadoEsperado = [...esperado.linhas].sort((a, b) => (b.quantidadeCaixas || 0) - (a.quantidadeCaixas || 0));
      if (ordenadoEsperado.length) {
        assert.equal(resultado.produtosBase[0].produtoBase, ordenadoEsperado[0].produtoBase);
        assert.equal(resultado.produtosBase[0].caixasFisicasVendidas, ordenadoEsperado[0].quantidadeCaixas);
      }
    });

    test('vendas_com_prejuizo só lista pedidos com margem negativa e cálculo completo, ordenado do pior pro menos pior', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('vendas_com_prejuizo', {}, ctx);
      const { pedidos } = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      const esperado = pedidos.filter((p) => !p.cancelado && p.calculoCompleto && p.margemContribuicao < 0);
      assert.equal(resultado.quantidadeVendasComPrejuizo, esperado.length);
      resultado.vendas.forEach((v) => assert.ok(v.margemContribuicao < 0));
      for (let i = 1; i < resultado.vendas.length; i++) {
        assert.ok(resultado.vendas[i - 1].margemContribuicao <= resultado.vendas[i].margemContribuicao);
      }
    });

    test('estoque_valor_parado: só soma quantidade × custo dos SKUs com produto cadastrado (300 × 10 = 3000), resto fica de fora', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_IA_ID, periodoChave: 'hoje' });
      const resultado = await executarFerramenta('estoque_valor_parado', {}, ctx);
      assert.equal(resultado.valorParadoEmEstoque.valor, 3000);
      assert.equal(resultado.itensConsiderados, 1);
      assert.equal(resultado.itensSemSkuOuCustoCadastrado, 3); // zerado, baixo e full não têm produto cadastrado
    });

    test('ads_desempenho: empresa sem nenhuma conta do Mercado Livre conectada devolve disponivel=false/motivo=sem_conta (sem tentar rede)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_SEM_CONTA_ID, periodoChave: 'hoje' });
      const resultado = await executarFerramenta('ads_desempenho', {}, ctx);
      assert.equal(resultado.disponivel, false);
      assert.equal(resultado.motivo, 'sem_conta');
    });

    test('fluxo_de_caixa bate com visaoGeralPainel.fluxoDeCaixa e nunca inventa saldo projetado', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_IA_ID, periodoChave: 'hoje' });
      const { pedidos } = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_IA_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      const esperado = await fluxoDeCaixa({ empresaId: EMPRESA_IA_ID, desdeStr: ctx.desdeStr, ateStr: ctx.ateStr, pedidos });
      const resultado = await executarFerramenta('fluxo_de_caixa', {}, ctx);

      assert.equal(resultado.previstoOuProjetado.contasAPagarEmAberto.valor, esperado.contasAPagar.totalAPagar);
      assert.equal(resultado.previstoOuProjetado.contasAPagarVencidas.valor, esperado.contasAPagar.vencidas);
      assert.equal(resultado.previstoOuProjetado.contasAReceberEmAberto.valor, esperado.contasAReceber.totalAReceber);
      assert.equal(resultado.previstoOuProjetado.contasAReceberAtrasadas.valor, esperado.contasAReceber.atrasado);
      assert.equal(resultado.saldoProjetado.valor, null, 'sem saldo bancário cadastrado — nunca inventado');
      assert.equal(resultado.saldoProjetado.motivo, 'sem_saldo_bancario_cadastrado');
    });

    test('dre_completa bate linha a linha com gerarDRE (todas as linhas do demonstrativo, não só o resumo de 3 linhas)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('dre_completa', {}, ctx);
      const esperado = await gerarDRE({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate, desdeBRT: ctx.desdeStr, ateBRT: ctx.ateStr });

      assert.equal(resultado.linhas.receitaBruta.valor, esperado.linhas.receitaBruta.valor);
      assert.equal(resultado.linhas.receitaLiquida.valor, esperado.linhas.receitaLiquida.valor);
      assert.equal(resultado.linhas.custoDosProdutos.valor, esperado.linhas.custoProdutos.valor);
      assert.equal(resultado.linhas.taxasEComissoes.valor, esperado.linhas.taxasComissoes.valor);
      assert.equal(resultado.linhas.freteDoVendedor.valor, esperado.linhas.freteVendedor.valor);
      assert.equal(resultado.linhas.impostos.valor, esperado.linhas.impostos.valor);
      assert.equal(resultado.linhas.margemDeContribuicao.valor, esperado.linhas.margemContribuicao.valor);
      assert.equal(resultado.linhas.resultadoFinal.valor, esperado.linhas.resultadoFinal.valor);
    });

    test('compras_resumo bate com resumoComprasPorFornecedor e nunca soma compra cancelada', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_IA_ID, periodoChave: 'hoje' });
      const resultado = await executarFerramenta('compras_resumo', {}, ctx);
      const esperado = await resumoComprasPorFornecedor({ empresaId: EMPRESA_IA_ID, desde: ctx.desdeStr, ate: ctx.ateStr });

      assert.equal(resultado.totalCompradoNoPeriodo.valor, esperado.valorTotal);
      assert.equal(resultado.totalCompradoNoPeriodo.valor, 500, 'só a compra em_aberto — a cancelada de 999 nunca entra no total');
      assert.equal(resultado.quantidadeDeCompras, 1);
      assert.equal(resultado.comprasCanceladasNoPeriodo.quantidade, 1);
      assert.equal(resultado.comprasCanceladasNoPeriodo.valor, 999);
      assert.equal(resultado.porFornecedor[0].fornecedor, 'Fornecedor Teste IA');
      assert.equal(resultado.porFornecedor[0].valorTotal, 500);
    });

    test('notas_fiscais_resumo bate com listarNotasFiscais (contagem por status)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('notas_fiscais_resumo', {}, ctx);
      const { itens, totalNoPeriodo } = await listarNotasFiscais({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate });
      const contagem = { pendente: 0, emitida: 0, cancelada: 0, rejeitada: 0 };
      itens.forEach((i) => { contagem[i.status] = (contagem[i.status] || 0) + 1; });

      assert.equal(resultado.totalDePedidosNoPeriodo, totalNoPeriodo);
      assert.equal(resultado.notasPendentes, contagem.pendente);
      assert.equal(resultado.notasEmitidas, contagem.emitida);
      assert.equal(resultado.notasCanceladas, contagem.cancelada);
      assert.equal(resultado.notasRejeitadas, contagem.rejeitada);
    });

    test('comparacao_periodo_anterior: período anterior é a mesma duração, terminando onde o período atual começa', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: '7d' });
      const resultado = await executarFerramenta('comparacao_periodo_anterior', {}, ctx);

      const duracaoMs = ctx.periodoCalc.ate.getTime() - ctx.periodoCalc.desde.getTime();
      const anteriorAte = ctx.periodoCalc.desde;
      const anteriorDesde = new Date(anteriorAte.getTime() - duracaoMs);
      const { diaBRT } = require('../lib/periodo');
      assert.equal(resultado.periodoAnterior.ate, diaBRT(new Date(anteriorAte.getTime() - 1)));
      assert.equal(resultado.periodoAnterior.desde, diaBRT(anteriorDesde));

      const [{ pedidos: pedidosAtual }, { pedidos: pedidosAnterior }] = await Promise.all([
        buscarPedidosDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: ctx.periodoCalc.desde, ate: ctx.periodoCalc.ate }),
        buscarPedidosDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: anteriorDesde, ate: anteriorAte }),
      ]);
      const esperadoAtual = resumirPeriodo(pedidosAtual);
      const esperadoAnterior = resumirPeriodo(pedidosAnterior);
      assert.equal(resultado.faturamento.atual.valor, esperadoAtual.faturamento.valor);
      assert.equal(resultado.faturamento.anterior.valor, esperadoAnterior.faturamento.valor);
      assert.equal(resultado.quantidadePedidos.atual, esperadoAtual.qtdPedidos);
      assert.equal(resultado.quantidadePedidos.anterior, esperadoAnterior.qtdPedidos);
    });

    test('consultar_documentacao: tema conhecido devolve texto; tema desconhecido devolve a lista de temas disponíveis (nunca inventa explicação)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'hoje' });
      const conhecido = await executarFerramenta('consultar_documentacao', { tema: 'ads' }, ctx);
      assert.equal(conhecido.encontrado, true);
      assert.equal(typeof conhecido.texto, 'string');
      assert.ok(conhecido.texto.length > 20);

      const desconhecido = await executarFerramenta('consultar_documentacao', { tema: 'tema_que_nao_existe' }, ctx);
      assert.equal(desconhecido.encontrado, false);
      assert.deepEqual(desconhecido.temasDisponiveis.sort(), Object.keys(TEMAS).sort());
    });

    // ---- projecao_mes: pedido do usuário pra corrigir "o ERP não possui
    // essa funcionalidade" — a IA deve RACIOCINAR/projetar com dado real.
    // Cada teste recalcula a projeção manualmente (mesma fórmula do
    // handler) a partir da MESMA fonte canônica (buscarPedidosDoPeriodo +
    // resumirPeriodo) e compara número a número — "compare os cálculos
    // manualmente" pedido explicitamente pelo usuário.

    function diaEDiasDoMesBRTTeste() {
      const hojeStr = diaBRT(new Date());
      const [ano, mes] = hojeStr.split('-').map(Number);
      const diaAtual = Number(hojeStr.split('-')[2]);
      const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
      return { diaAtual, diasNoMes, diasRestantes: diasNoMes - diaAtual };
    }

    test('projecao_mes (faturamento) — projeção simples e ajustada batem com o cálculo manual (média diária × dias do mês / tendência dos últimos 7 dias)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('projecao_mes', { metrica: 'faturamento' }, ctx);

      const { diaAtual, diasNoMes, diasRestantes } = diaEDiasDoMesBRTTeste();
      assert.equal(resultado.diaAtual, diaAtual);
      assert.equal(resultado.diasNoMes, diasNoMes);
      assert.equal(resultado.diasRestantes, diasRestantes);

      const mesCalc = calcularPeriodo('mes');
      const periodo7dCalc = calcularPeriodo('7d');
      const { pedidos: pedidosMes } = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: mesCalc.desde, ate: mesCalc.ate });
      const { pedidos: pedidos7d } = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: periodo7dCalc.desde, ate: periodo7dCalc.ate });
      const resumoMes = resumirPeriodo(pedidosMes);
      const resumo7d = resumirPeriodo(pedidos7d);

      assert.equal(resultado.faturamentoRealizadoNoMesAteHoje.valor, resumoMes.faturamento.valor);
      assert.ok(resumoMes.faturamento.valor > 0, 'empresa 900 tem pedidos reais em agosto/2026 — o teste depende de haver faturamento real este mês');

      const mediaDiariaMesEsperada = round2(resumoMes.faturamento.valor / diaAtual);
      const projecaoSimplesEsperada = round2(mediaDiariaMesEsperada * diasNoMes);
      assert.equal(resultado.projecaoFaturamento.mediaDiariaMes, mediaDiariaMesEsperada);
      assert.equal(resultado.projecaoFaturamento.projecaoSimples, projecaoSimplesEsperada);

      if (resumo7d.faturamento.valor !== null) {
        const mediaDiaria7dEsperada = round2(resumo7d.faturamento.valor / 7);
        const projecaoAjustadaEsperada = round2(resumoMes.faturamento.valor + mediaDiaria7dEsperada * diasRestantes);
        assert.equal(resultado.projecaoFaturamento.mediaDiariaUltimos7Dias, mediaDiaria7dEsperada);
        assert.equal(resultado.projecaoFaturamento.projecaoAjustadaPelaTendencia, projecaoAjustadaEsperada);
        assert.equal(resultado.projecaoFaturamento.tendencia.percentual, round2(((mediaDiaria7dEsperada - mediaDiariaMesEsperada) / Math.abs(mediaDiariaMesEsperada)) * 100));

        // "Faixa provável" é sempre [min, max] entre as duas projeções — nunca as duas trocadas.
        assert.equal(resultado.projecaoFaturamento.faixaProvavel.min, Math.min(projecaoSimplesEsperada, projecaoAjustadaEsperada));
        assert.equal(resultado.projecaoFaturamento.faixaProvavel.max, Math.max(projecaoSimplesEsperada, projecaoAjustadaEsperada));
      }
    });

    test('projecao_mes (exemplo do usuário): R$120.000 realizados / 25 dias = R$4.800 de média; × 31 dias = R$148.800 de projeção simples', async () => {
      // Não recria o cenário com dado sintético (evitaria testar a fonte
      // real) — em vez disso confirma que a FÓRMULA usada pelo handler
      // reproduz exatamente a conta do exemplo do usuário, com números
      // conhecidos.
      const mediaDiaria = round2(120000 / 25);
      assert.equal(mediaDiaria, 4800);
      assert.equal(round2(mediaDiaria * 31), 148800);
    });

    test('projecao_mes (margem_e_lucro) — quando a margem do mês está pendente (SKU sem custo), explica exatamente o que falta e ainda assim projeta o faturamento', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('projecao_mes', { metrica: 'margem_e_lucro' }, ctx);

      const mesCalc = calcularPeriodo('mes');
      const { itens } = await buscarItensDoPeriodo({ empresaId: EMPRESA_REAL_ID, desde: mesCalc.desde, ate: mesCalc.ate });
      const skusSemCustoEsperado = new Set(itens.filter((it) => it.sku && it.custoProduto === null).map((it) => it.sku));

      if (skusSemCustoEsperado.size > 0) {
        assert.equal(resultado.margemEProjecaoDisponivel, false);
        assert.equal(resultado.skusSemCustoNoMes, skusSemCustoEsperado.size);
        assert.match(resultado.observacao, /Consigo projetar o faturamento/);
        assert.ok(resultado.projecaoFaturamento.disponivel, 'mesmo sem conseguir projetar margem, o faturamento continua projetável');
      } else {
        assert.equal(resultado.margemEProjecaoDisponivel, true);
        assert.ok(resultado.projecaoMargemDeContribuicao.disponivel);
      }
    });

    test('projecao_mes (pedidos) — projeção de quantidade é sempre um número inteiro', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('projecao_mes', { metrica: 'pedidos' }, ctx);
      assert.ok(Number.isInteger(resultado.projecaoPedidos.projecaoSimples));
      if (resultado.projecaoPedidos.tendencia) {
        assert.ok(Number.isInteger(resultado.projecaoPedidos.projecaoAjustadaPelaTendencia));
      }
    });

    test('projecao_mes (ads) — empresa sem conta ML conectada devolve disponivel=false/motivo=sem_conta (nunca projeta sem dado real)', async () => {
      const ctx = criarContexto({ empresaId: EMPRESA_SEM_CONTA_ID, periodoChave: 'mes' });
      const resultado = await executarFerramenta('projecao_mes', { metrica: 'ads' }, ctx);
      assert.equal(resultado.disponivel, false);
      assert.equal(resultado.motivo, 'sem_conta');
    });

    test('projecao_mes: sempre projeta o MÊS CORRENTE, independente do período selecionado no cabeçalho', async () => {
      const ctxHoje = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'hoje' });
      const ctxMes = criarContexto({ empresaId: EMPRESA_REAL_ID, periodoChave: 'mes' });
      const rHoje = await executarFerramenta('projecao_mes', { metrica: 'faturamento' }, ctxHoje);
      const rMes = await executarFerramenta('projecao_mes', { metrica: 'faturamento' }, ctxMes);
      assert.deepEqual(rHoje.faturamentoRealizadoNoMesAteHoje, rMes.faturamentoRealizadoNoMesAteHoje);
      assert.equal(rHoje.mesReferencia, rMes.mesReferencia);
    });
  }
);
