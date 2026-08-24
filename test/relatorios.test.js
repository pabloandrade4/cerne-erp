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
});
