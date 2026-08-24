// Testes de INTEGRAÇÃO (precisa de Postgres local — mesmo padrão de
// test/relatorioVendas.integration.test.js) da DRE, ativada em 24/08/2026.
// A DRE não tem fórmula própria — estes testes confirmam que lib/dre.js
// reorganiza corretamente os números que já vêm de
// lib/relatorioVendas.js (buscarPedidosDoPeriodo/resumirPeriodo) e de
// lib/contasPagar.js (resumoContasPagar), contra os 11 pedidos reais da
// empresa/conta 900 (mesmos da reconciliação PF ERP x Mercado Turbo — 10
// pagos + 1 cancelado, 2000018086572830).
//
// Como rodar:
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test dre.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;
const PREFIXO_TESTE = '[TESTE AUTOMATIZADO]';

describe('DRE — 24/08/2026', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let dreLib, relatorioVendas, contasPagar, periodo, pool;
  let desde, ate, desdeBRT, ateBRT;
  let contaPagaId;

  before(async () => {
    dreLib = require('../lib/dre');
    relatorioVendas = require('../lib/relatorioVendas');
    contasPagar = require('../lib/contasPagar');
    periodo = require('../lib/periodo');
    pool = require('../db/pool');

    desde = periodo.inicioDoDiaBRTDeString('2026-08-22');
    ate = periodo.inicioDoDiaBRTDeString('2026-08-25');
    ({ desde: desdeBRT, ate: ateBRT } = periodo.periodoParaDatasBRT({ desde, ate }));

    // Uma despesa paga DENTRO do período, pra testar a linha "Despesas /
    // Contas pagas do período" da DRE.
    const criada = await contasPagar.criarContaPagar({
      empresaId: EMPRESA_ID, descricao: PREFIXO_TESTE + ' despesa DRE', valor: 120.5, vencimento: '2026-08-23',
    });
    const pago = await contasPagar.marcarComoPago(criada.conta.id, '2026-08-23');
    contaPagaId = pago.conta.id;
  });

  after(async () => {
    await pool.query(`DELETE FROM contas_pagar WHERE id = $1`, [contaPagaId]);
  });

  test('receitaBruta = faturamento (não cancelado) + cancelamentos — nunca uma fórmula nova', async () => {
    const { pedidos } = await relatorioVendas.buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde, ate });
    const resumo = relatorioVendas.resumirPeriodo(pedidos);

    const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_ID, desde, ate, desdeBRT, ateBRT });

    assert.equal(dre.hasOrders, true);
    assert.equal(dre.qtdPedidos, resumo.qtdPedidos);
    assert.equal(dre.qtdPedidosCancelados, resumo.cancelados.quantidade);
    assert.ok(dre.qtdPedidosCancelados >= 1, 'deveria haver ao menos o pedido cancelado real 2000018086572830');

    const receitaBrutaEsperada = Math.round((resumo.faturamento.valor + resumo.cancelados.valor) * 100) / 100;
    assert.equal(dre.linhas.receitaBruta.valor, receitaBrutaEsperada);
    assert.equal(dre.linhas.cancelamentos.valor, resumo.cancelados.valor);
    assert.equal(dre.linhas.cancelamentos.valor, 86); // pedido 2000018086572830, valor real
  });

  test('Margem de Contribuição e seu percentual são lidos direto de resumirPeriodo — nunca recalculados por subtração', async () => {
    const { pedidos } = await relatorioVendas.buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde, ate });
    const resumo = relatorioVendas.resumirPeriodo(pedidos);

    const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_ID, desde, ate, desdeBRT, ateBRT });

    assert.equal(dre.linhas.margemContribuicao.valor, resumo.margemContribuicao.valor);
    assert.equal(dre.linhas.margemContribuicao.percentual, resumo.margemPercentual);
    assert.equal(dre.linhas.custoProdutos.valor, resumo.custoProduto.valor);
    assert.equal(dre.linhas.taxasComissoes.valor, resumo.tarifas.valor);
    assert.equal(dre.linhas.freteVendedor.valor, resumo.freteVendedor.valor);
    assert.equal(dre.linhas.impostos.valor, resumo.imposto.valor);
    assert.equal(dre.linhas.descontos.valor, resumo.desconto.valor);
  });

  test('Receita Líquida = Receita Bruta − Cancelamentos − Descontos', async () => {
    const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_ID, desde, ate, desdeBRT, ateBRT });
    const esperado = Math.round((dre.linhas.receitaBruta.valor - dre.linhas.cancelamentos.valor - dre.linhas.descontos.valor) * 100) / 100;
    assert.equal(dre.linhas.receitaLiquida.valor, esperado);
  });

  test('Despesas do período reaproveita resumoContasPagar (pagasNoPeriodo) — inclui a despesa paga criada no teste', async () => {
    const resumoDespesas = await contasPagar.resumoContasPagar({ empresaId: EMPRESA_ID, desde: desdeBRT, ate: ateBRT });
    const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_ID, desde, ate, desdeBRT, ateBRT });

    assert.equal(dre.linhas.despesasPeriodo.valor, resumoDespesas.pagasNoPeriodo);
    assert.ok(dre.linhas.despesasPeriodo.valor >= 120.5);
  });

  test('Resultado Final = Margem de Contribuição − Despesas do período', async () => {
    const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_ID, desde, ate, desdeBRT, ateBRT });
    if (dre.linhas.margemContribuicao.valor === null) {
      assert.equal(dre.linhas.resultadoFinal.valor, null);
    } else {
      const esperado = Math.round((dre.linhas.margemContribuicao.valor - dre.linhas.despesasPeriodo.valor) * 100) / 100;
      assert.equal(dre.linhas.resultadoFinal.valor, esperado);
    }
  });

  test('período sem nenhum pedido: linhas de receita ficam "Sem dados" (null), despesas continua um valor real', async () => {
    const desdeVazio = periodo.inicioDoDiaBRTDeString('2020-01-01');
    const ateVazio = periodo.inicioDoDiaBRTDeString('2020-01-02');
    const { desde: dB, ate: aB } = periodo.periodoParaDatasBRT({ desde: desdeVazio, ate: ateVazio });

    const dre = await dreLib.gerarDRE({ empresaId: EMPRESA_ID, desde: desdeVazio, ate: ateVazio, desdeBRT: dB, ateBRT: aB });

    assert.equal(dre.hasOrders, false);
    assert.equal(dre.linhas.receitaBruta.valor, null);
    assert.equal(dre.linhas.margemContribuicao.valor, null);
    assert.equal(dre.linhas.resultadoFinal.valor, null);
    // despesas do período é sempre um valor real (0 quando nada foi pago),
    // nunca "sem dados" — independe de haver venda no período
    assert.equal(dre.linhas.despesasPeriodo.valor, 0);
  });

  test('percentualSobreFaturamento: null quando base é 0 ou null; nunca Infinity/NaN', () => {
    assert.equal(dreLib.percentualSobreFaturamento(10, 0), null);
    assert.equal(dreLib.percentualSobreFaturamento(10, null), null);
    assert.equal(dreLib.percentualSobreFaturamento(null, 100), null);
    assert.equal(dreLib.percentualSobreFaturamento(50, 200), 25);
  });
});
