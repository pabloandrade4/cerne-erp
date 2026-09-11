// Testes de INTEGRAÇÃO (precisa de Postgres local — mesmo padrão de
// test/relatorioVendas.integration.test.js e test/dre.test.js) da tela
// Relatórios, ativada em 25/08/2026.
//
// Regra central do usuário: "os números dos Relatórios devem usar as MESMAS
// regras já utilizadas em Visão Geral, Pedidos e Financeiro — não crie
// cálculos separados. Se Visão Geral mostrar R$ X de faturamento para
// determinado período, o relatório do mesmo período precisa mostrar o
// mesmo valor." Estes testes existem só para provar isso: comparam a saída
// de lib/relatoriosAgregados.js com a saída de
// lib/relatorioVendas.js (buscarPedidosDoPeriodo/resumirPeriodo) para os
// mesmos 11 pedidos reais da empresa/conta 900 (10 pagos + 1 cancelado,
// reconciliação PF ERP x Mercado Turbo).
//
// Como rodar (Postgres já seedado com os pedidos reais — ver comentário em
// relatorioVendas.integration.test.js para como popular):
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test relatorios.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;

describe('Relatórios — reconciliação com Visão Geral/Pedidos/Financeiro (25/08/2026)', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let relatoriosAgregados, relatorioVendas, periodo;
  let desde, ate, desdeStr, ateStr;
  let pedidos, resumoEsperado;

  before(async () => {
    relatoriosAgregados = require('../lib/relatoriosAgregados');
    relatorioVendas = require('../lib/relatorioVendas');
    periodo = require('../lib/periodo');

    // Janela ampla o bastante para cobrir os pedidos reais de teste (2026-08),
    // igual ao período "30d"/"mes" usado nas outras telas.
    desde = periodo.inicioDoDiaBRTDeString('2026-08-01');
    ate = new Date();
    ({ desde: desdeStr, ate: ateStr } = periodo.periodoParaDatasBRT({ desde, ate }));

    const resultado = await relatorioVendas.buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde, ate });
    pedidos = resultado.pedidos;
    resumoEsperado = relatorioVendas.resumirPeriodo(pedidos);
  });

  after(async () => {
    await require('../db/pool').end();
  });

  test('Vendas e Margem: faturamento/tarifas/frete/imposto/custo batem exatamente com resumirPeriodo', async () => {
    assert.ok(resumoEsperado.qtdPedidos >= 10, 'deveria haver ao menos os 10 pedidos pagos reais de teste');

    const relatorio = await relatoriosAgregados.relatorioVendasMargem({
      empresaId: EMPRESA_ID, contaId: null, desde, ate, desdeStr, ateStr,
    });

    assert.equal(relatorio.resumo.qtdPedidos, resumoEsperado.qtdPedidos);
    assert.equal(relatorio.resumo.faturamento.valor, resumoEsperado.faturamento.valor);
    assert.equal(relatorio.resumo.tarifas.valor, resumoEsperado.tarifas.valor);
    assert.equal(relatorio.resumo.freteVendedor.valor, resumoEsperado.freteVendedor.valor);
    assert.equal(relatorio.resumo.imposto.valor, resumoEsperado.imposto.valor);
    assert.equal(relatorio.resumo.custoProduto.valor, resumoEsperado.custoProduto.valor);
    assert.equal(relatorio.resumo.margemContribuicao.valor, resumoEsperado.margemContribuicao.valor);
    assert.equal(relatorio.resumo.cancelados.quantidade, resumoEsperado.cancelados.quantidade);
  });

  test('Vendas e Margem: nunca calcula uma fórmula própria — resumo é o MESMO objeto (por valor) de resumirPeriodo', async () => {
    const relatorio = await relatoriosAgregados.relatorioVendasMargem({
      empresaId: EMPRESA_ID, contaId: null, desde, ate, desdeStr, ateStr,
    });
    assert.deepEqual(relatorio.resumo, resumoEsperado);
  });

  test('Marketplaces: soma das lojas bate com o total geral (só existe a loja PFEMBALAGEMS/900 no fixture)', async () => {
    const relatorio = await relatoriosAgregados.relatorioMarketplaces({ empresaId: EMPRESA_ID, desde, ate });
    assert.ok(relatorio.linhas.length >= 1);

    const somaFaturamento = relatorio.linhas.reduce((s, l) => s + (l.resumo.faturamento.valor || 0), 0);
    const somaTarifas = relatorio.linhas.reduce((s, l) => s + (l.resumo.tarifas.valor || 0), 0);
    const somaPedidos = relatorio.linhas.reduce((s, l) => s + l.resumo.qtdPedidos, 0);

    assert.equal(Math.round(somaFaturamento * 100) / 100, resumoEsperado.faturamento.valor);
    assert.equal(Math.round(somaTarifas * 100) / 100, resumoEsperado.tarifas.valor);
    assert.equal(somaPedidos, resumoEsperado.qtdPedidos);

    const linhaConta900 = relatorio.linhas.find((l) => l.contaMlId === 900);
    assert.ok(linhaConta900, 'deveria existir uma linha para a conta 900 (PFEMBALAGEMS)');
    // Como só há 1 loja no fixture, o resumo da loja tem que ser IDÊNTICO ao geral.
    assert.deepEqual(linhaConta900.resumo, resumoEsperado);
  });

  test('Produtos: soma de faturamento/imposto por SKU bate com o total de resumirPeriodo', async () => {
    const relatorio = await relatoriosAgregados.relatorioProdutos({
      empresaId: EMPRESA_ID, contaId: null, desde, ate, sku: null,
    });
    assert.ok(relatorio.linhas.length > 0);

    const somaFaturamento = relatorio.linhas.reduce((s, l) => s + (l.faturamento || 0), 0);
    const somaImposto = relatorio.linhas.reduce((s, l) => s + (l.imposto || 0), 0);
    const somaQuantidade = relatorio.linhas.reduce((s, l) => s + (l.quantidade || 0), 0);

    // Faturamento e imposto são decompostos exatamente por item (rateio
    // documentado em lib/relatorioVendas.js) — a soma tem que reconciliar
    // com o total de pedidos não cancelados até o centavo.
    assert.equal(Math.round(somaFaturamento * 100) / 100, resumoEsperado.faturamento.valor);
    assert.equal(Math.round(somaImposto * 100) / 100, resumoEsperado.imposto.valor);

    const { pedidos: todosPedidos } = await relatorioVendas.buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde, ate });
    const totalUnidadesEsperado = todosPedidos.filter((p) => !p.cancelado).reduce((s, p) => s + (p.qtdUnidades || 0), 0);
    assert.equal(somaQuantidade, totalUnidadesEsperado);
  });

  test('Produtos: filtro de SKU restringe a lista sem mudar os valores da(s) linha(s) restante(s)', async () => {
    const completo = await relatoriosAgregados.relatorioProdutos({ empresaId: EMPRESA_ID, contaId: null, desde, ate, sku: null });
    assert.ok(completo.linhas.length > 1, 'fixture precisa ter mais de 1 SKU pra este teste fazer sentido');

    const alvo = completo.linhas[0];
    const filtrado = await relatoriosAgregados.relatorioProdutos({ empresaId: EMPRESA_ID, contaId: null, desde, ate, sku: alvo.sku });
    assert.equal(filtrado.linhas.length, 1);
    assert.equal(filtrado.linhas[0].sku, alvo.sku);
    assert.equal(filtrado.linhas[0].faturamento, alvo.faturamento);
  });

  test('Isolamento: empresa sem pedidos nunca retorna dado de outra empresa', async () => {
    const relatorio = await relatoriosAgregados.relatorioVendasMargem({
      empresaId: 999999, contaId: null, desde, ate, desdeStr, ateStr,
    });
    assert.equal(relatorio.resumo.qtdPedidos, 0);
    assert.equal(relatorio.resumo.faturamento.valor, null);
  });

  // Produtos, visão "Por Caixa" — ativada em 25/08/2026 (ver
  // docs/02-decisoes.md e docs/04-alteracoes.md). Os SKUs reais do fixture
  // (empresa 900) já seguem o padrão "dígitos no início = quantidade por
  // kit": 25CX-19X12X12/50CX-19X12X12 -> CX-19X12X12; 100CX-16X11X8/
  // 50CX-16X11X8 -> CX-16X11X8; 25CX-20X14X8 -> CX-20X14X8;
  // 50CX-16X11X6 -> CX-16X11X6. Nenhum vínculo está salvo em
  // produto_base_skus pra esta empresa — os números abaixo exercitam o
  // fallback automático (interpretarSku), calculados manualmente a partir
  // dos itens reais (pedido 670, cancelado, fica de fora — mesma exclusão
  // de buscarItensDoPeriodo).
  describe('Produtos — visão "Por Caixa" (agrupamento por produto base físico)', () => {
    test('agrupa corretamente os SKUs reais em produto base, com caixas físicas = kits × multiplicador (nunca dividindo o faturamento)', async () => {
      const relatorio = await relatoriosAgregados.relatorioProdutosPorCaixa({ empresaId: EMPRESA_ID, contaId: null, desde, ate });

      const porBase = Object.fromEntries(relatorio.linhas.map((l) => [l.produtoBase, l]));

      // CX-16X11X8: 100CX (pedido 666, 2 kits, R$145,40) + 50CX (pedido 662,
      // 1 kit, R$43,00 + pedido 667, 2 kits, R$86,00; pedido 670 cancelado
      // fica de fora) = 200 + 50 + 100 = 350 caixas; 5 kits; R$274,40; 3 pedidos.
      assert.ok(porBase['CX-16X11X8'], 'deveria existir o grupo CX-16X11X8');
      assert.equal(porBase['CX-16X11X8'].quantidadeCaixas, 350);
      assert.equal(porBase['CX-16X11X8'].kitsVendidos, 5);
      assert.equal(porBase['CX-16X11X8'].faturamento, 274.40);
      assert.equal(porBase['CX-16X11X8'].quantidadePedidos, 3);
      assert.equal(porBase['CX-16X11X8'].origemHeuristica, true, 'sem vínculo salvo, deveria vir do padrão do SKU');

      // CX-19X12X12: 25CX (pedidos 661+663, 1+1=2 kits, R$33,47+R$33,47) +
      // 50CX (pedido 671, 1 kit, R$53,47) = 50 + 50 = 100 caixas; 3 kits;
      // R$120,41; 3 pedidos.
      assert.ok(porBase['CX-19X12X12']);
      assert.equal(porBase['CX-19X12X12'].quantidadeCaixas, 100);
      assert.equal(porBase['CX-19X12X12'].kitsVendidos, 3);
      assert.equal(porBase['CX-19X12X12'].faturamento, 120.41);
      assert.equal(porBase['CX-19X12X12'].quantidadePedidos, 3);

      // CX-20X14X8: 25CX (pedido 665, 1 kit, R$33,47 + pedido 668, 2 kits,
      // R$59,96) = 25 + 50 = 75 caixas; 3 kits; R$93,43; 2 pedidos.
      assert.ok(porBase['CX-20X14X8']);
      assert.equal(porBase['CX-20X14X8'].quantidadeCaixas, 75);
      assert.equal(porBase['CX-20X14X8'].kitsVendidos, 3);
      assert.equal(porBase['CX-20X14X8'].faturamento, 93.43);
      assert.equal(porBase['CX-20X14X8'].quantidadePedidos, 2);

      // CX-16X11X6: 50CX (pedido 664, 1 kit, R$35,34 + pedido 669, 1 kit,
      // R$35,34) = 50 + 50 = 100 caixas; 2 kits; R$70,68; 2 pedidos.
      assert.ok(porBase['CX-16X11X6']);
      assert.equal(porBase['CX-16X11X6'].quantidadeCaixas, 100);
      assert.equal(porBase['CX-16X11X6'].kitsVendidos, 2);
      assert.equal(porBase['CX-16X11X6'].faturamento, 70.68);
      assert.equal(porBase['CX-16X11X6'].quantidadePedidos, 2);
    });

    test('faturamento somado das 4 medidas bate exatamente com o total de resumirPeriodo (nenhum SKU deste fixture fica sem produto base)', async () => {
      const relatorio = await relatoriosAgregados.relatorioProdutosPorCaixa({ empresaId: EMPRESA_ID, contaId: null, desde, ate });
      assert.equal(relatorio.semProdutoBase.length, 0);
      const somaFaturamento = relatorio.linhas.reduce((s, l) => s + l.faturamento, 0);
      assert.equal(Math.round(somaFaturamento * 100) / 100, resumoEsperado.faturamento.valor);
    });

    test('detalhamento por SKU dentro do produto base bate com o multiplicador esperado', async () => {
      const relatorio = await relatoriosAgregados.relatorioProdutosPorCaixa({ empresaId: EMPRESA_ID, contaId: null, desde, ate });
      const cx191212 = relatorio.linhas.find((l) => l.produtoBase === 'CX-19X12X12');
      const skus = Object.fromEntries(cx191212.skus.map((s) => [s.sku, s]));
      assert.equal(skus['25CX-19X12X12'].multiplicador, 25);
      assert.equal(skus['25CX-19X12X12'].quantidadeCaixas, 50);
      assert.equal(skus['50CX-19X12X12'].multiplicador, 50);
      assert.equal(skus['50CX-19X12X12'].quantidadeCaixas, 50);
    });

    test('SKU que não segue o padrão (sem dígitos no início) nunca é chutado — some do agrupamento e aparece em "sem produto base identificado"', async () => {
      const pool = require('../db/pool');
      // Conta/pedido/item TOTALMENTE isolados (nunca referenciando um ID de
      // linha real do fixture — outros arquivos de teste, ex:
      // relatorioVendas.integration.test.js e mlSync.reconciliacao.
      // integration.test.js, apagam e recriam os pedidos de conta_ml_id=900
      // com novos IDs a cada execução; um ID de pedido hardcoded quebraria
      // de forma imprevisível quando os testes rodam juntos). Uma conta ML
      // NOVA sob a mesma empresa 900 nunca é tocada por esses reseeds
      // (eles filtram por conta_ml_id = 900 especificamente).
      const { rows: contaRows } = await pool.query(
        `INSERT INTO ml_contas (empresa_id, ml_user_id, nickname, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, 999888777001, '[TESTE AUTOMATIZADO] conta', 'x', 'x', now() + interval '1 hour', 'ativa')
         RETURNING id`,
        [EMPRESA_ID]
      );
      const contaId = contaRows[0].id;
      // Data fixa (não now()) dentro da janela [desde, ate) capturada em
      // before() no início do describe — now() no momento do INSERT pode já
      // ter passado do limite superior `ate` (exclusivo) se este teste rodar
      // um pouco depois do before(), fazendo o pedido cair fora do período
      // por pura questão de timing, não de lógica.
      const { rows: pedidoRows } = await pool.query(
        `INSERT INTO ml_pedidos (conta_ml_id, ml_order_id, data_criacao, data_fechamento, status, valor_total, moeda)
         VALUES ($1, 999888777001, '2026-08-20T12:00:00-03:00', '2026-08-20T12:00:00-03:00', 'paid', 45.00, 'BRL')
         RETURNING id`,
        [contaId]
      );
      const pedidoId = pedidoRows[0].id;
      await pool.query(
        `INSERT INTO ml_pedido_itens (pedido_id, sku, quantidade, valor_total_item)
         VALUES ($1, 'ACESSORIO-AVULSO-SEM-PADRAO', 3, 45.00)`,
        [pedidoId]
      );
      try {
        const relatorio = await relatoriosAgregados.relatorioProdutosPorCaixa({ empresaId: EMPRESA_ID, contaId: null, desde, ate });
        const semBase = relatorio.semProdutoBase.find((l) => l.sku === 'ACESSORIO-AVULSO-SEM-PADRAO');
        assert.ok(semBase, 'SKU sem padrão deveria aparecer em semProdutoBase');
        assert.equal(semBase.kitsVendidos, 3);
        assert.equal(semBase.faturamento, 45.00);
        assert.equal(semBase.quantidadePedidos, 1);
        assert.ok(!relatorio.linhas.some((l) => l.skus.some((s) => s.sku === 'ACESSORIO-AVULSO-SEM-PADRAO')), 'nunca deveria entrar em nenhum grupo de produto base');
      } finally {
        await pool.query('DELETE FROM ml_pedidos WHERE id = $1', [pedidoId]); // cascade apaga o item
        await pool.query('DELETE FROM ml_contas WHERE id = $1', [contaId]);
      }
    });

    test('vínculo SALVO em produto_base_skus sempre vence sobre o padrão automático do SKU', async () => {
      const pool = require('../db/pool');
      const { rows: baseRows } = await pool.query(
        `INSERT INTO produtos_base (empresa_id, codigo, nome) VALUES ($1, $2, $3)
         ON CONFLICT (empresa_id, codigo) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
        [EMPRESA_ID, '[TESTE] CX-CUSTOM', 'Produto base de teste']
      );
      const produtoBaseId = baseRows[0].id;
      // '50CX-16X11X8' normalmente resolveria (pelo padrão) pra CX-16X11X8
      // com multiplicador 50 — um vínculo salvo com um multiplicador
      // diferente (77) e um produto base diferente precisa vencer.
      await pool.query(
        `INSERT INTO produto_base_skus (empresa_id, sku, produto_base_id, multiplicador, origem)
         VALUES ($1, '50CX-16X11X8', $2, 77, 'manual')`,
        [EMPRESA_ID, produtoBaseId]
      );
      try {
        const resolucoes = await relatoriosAgregados.resolverProdutosBasePorSku(EMPRESA_ID, ['50CX-16X11X8', '25CX-19X12X12', 'SKU-QUE-NAO-EXISTE-123']);
        assert.deepEqual(resolucoes['50CX-16X11X8'], { codigoBase: '[TESTE] CX-CUSTOM', multiplicador: 77, origem: 'salvo' });
        // SKU sem vínculo continua caindo no padrão automático normalmente.
        assert.deepEqual(resolucoes['25CX-19X12X12'], { codigoBase: 'CX-19X12X12', multiplicador: 25, origem: 'padrao_sku' });
      } finally {
        await pool.query('DELETE FROM produto_base_skus WHERE empresa_id = $1 AND sku = $2', [EMPRESA_ID, '50CX-16X11X8']);
        await pool.query('DELETE FROM produtos_base WHERE id = $1', [produtoBaseId]);
      }
    });

    test('período "hoje" calcula só vendas de hoje (fixture é de agosto/2026 — nenhum pedido deveria aparecer)', async () => {
      const periodoHoje = periodo.calcularPeriodo('hoje');
      const relatorio = await relatoriosAgregados.relatorioProdutosPorCaixa({
        empresaId: EMPRESA_ID, contaId: null, desde: periodoHoje.desde, ate: periodoHoje.ate,
      });
      assert.equal(relatorio.linhas.length, 0);
      assert.equal(relatorio.semProdutoBase.length, 0);
    });

    test('filtro de loja (contaId) inexistente devolve lista vazia; contaId real devolve o mesmo total', async () => {
      const semLoja = await relatoriosAgregados.relatorioProdutosPorCaixa({ empresaId: EMPRESA_ID, contaId: 999999, desde, ate });
      assert.equal(semLoja.linhas.length, 0);

      const comLojaReal = await relatoriosAgregados.relatorioProdutosPorCaixa({ empresaId: EMPRESA_ID, contaId: 900, desde, ate });
      const semFiltro = await relatoriosAgregados.relatorioProdutosPorCaixa({ empresaId: EMPRESA_ID, contaId: null, desde, ate });
      assert.deepEqual(comLojaReal.linhas, semFiltro.linhas);
    });

    test('Isolamento: empresa sem pedidos nunca retorna dado de outra empresa', async () => {
      const relatorio = await relatoriosAgregados.relatorioProdutosPorCaixa({ empresaId: 999999, contaId: null, desde, ate });
      assert.equal(relatorio.linhas.length, 0);
      assert.equal(relatorio.semProdutoBase.length, 0);
    });
  });
});
