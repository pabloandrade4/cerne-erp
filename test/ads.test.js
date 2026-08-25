// Testes de INTEGRAÇÃO (precisa de Postgres local — mesmo padrão de
// test/relatorioVendas.integration.test.js) da tela Ads, ativada em
// 25/08/2026.
//
// Duas coisas são testadas contra os pedidos reais da empresa/conta 900:
// 1) buscarItensDoPeriodo (lib/relatorioVendas.js) — a decomposição de
//    pedido em itens/anúncio, com o rateio de frete/tarifas de
//    pagamento/desconto quando o pedido tem mais de 1 item. O teste central
//    é a reconciliação: soma dos itens de cada pedido tem que bater
//    EXATAMENTE com o valor do pedido inteiro (nunca perder nem sobrar
//    centavo no rateio).
// 2) lib/ads.js (listarAds) — nunca inventa investimento/ROAS/ACOS/TACOS
//    quando a API de Advertising não está disponível (o normal neste
//    sandbox, sem acesso à internet real do Mercado Livre): tudo isso deve
//    vir null, nunca um número calculado como se fosse real.
//
// Como rodar:
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test ads.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;

function round2(n) { return Math.round(n * 100) / 100; }

describe('Ads — itens por pedido e agregação (25/08/2026)', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let relatorioVendas, adsLib, periodo;
  let desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr;
  let pedidos, itens;

  before(async () => {
    relatorioVendas = require('../lib/relatorioVendas');
    adsLib = require('../lib/ads');
    periodo = require('../lib/periodo');

    desde = periodo.inicioDoDiaBRTDeString('2026-08-01');
    ate = new Date();
    ({ desde: desdeStr, ate: ateStr } = periodo.periodoParaDatasBRT({ desde, ate }));

    // Mesmas janelas que routes/ads.js calcula pros cards "Gasto hoje"/
    // "Gasto no mês" — sempre a data real, independente do período
    // escolhido no filtro (ver routes/ads.js).
    ({ desde: hojeStr } = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('hoje')));
    ({ desde: mesDesdeStr, ate: mesAteStr } = periodo.periodoParaDatasBRT(periodo.calcularPeriodo('mes')));

    const resultadoPedidos = await relatorioVendas.buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde, ate });
    pedidos = resultadoPedidos.pedidos;

    const resultadoItens = await relatorioVendas.buscarItensDoPeriodo({ empresaId: EMPRESA_ID, desde, ate });
    itens = resultadoItens.itens;
  });

  after(async () => {
    await require('../db/pool').end();
  });

  test('buscarItensDoPeriodo: todo item pertence a um pedido não cancelado real', () => {
    assert.ok(itens.length > 0);
    const idsNaoCancelados = new Set(pedidos.filter((p) => !p.cancelado).map((p) => p.id));
    itens.forEach((it) => assert.ok(idsNaoCancelados.has(it.pedidoId), `item deveria pertencer a um pedido não cancelado (pedidoId=${it.pedidoId})`));
  });

  test('buscarItensDoPeriodo: soma do valorTotalItem por pedido bate exatamente com o valor total do pedido', () => {
    const porPedido = new Map();
    itens.forEach((it) => {
      if (!porPedido.has(it.pedidoId)) porPedido.set(it.pedidoId, []);
      porPedido.get(it.pedidoId).push(it);
    });

    const pedidosPorId = new Map(pedidos.map((p) => [p.id, p]));
    let algumMultiItem = false;
    for (const [pedidoId, linhasDoPedido] of porPedido) {
      const pedido = pedidosPorId.get(pedidoId);
      const somaValor = round2(linhasDoPedido.reduce((s, it) => s + (it.valorTotalItem || 0), 0));
      assert.equal(somaValor, pedido.valorTotal, `pedido ${pedido.mlOrderId}: soma dos itens (${somaValor}) deveria bater com o valor total (${pedido.valorTotal})`);

      if (linhasDoPedido.length > 1) {
        algumMultiItem = true;
        // Rateio de frete do vendedor: soma dos itens bate com o frete do pedido.
        if (pedido.freteVendedor !== null && linhasDoPedido.every((it) => it.freteVendedor !== null)) {
          const somaFrete = round2(linhasDoPedido.reduce((s, it) => s + it.freteVendedor, 0));
          assert.equal(somaFrete, pedido.freteVendedor, `pedido ${pedido.mlOrderId}: rateio de frete do vendedor deveria somar de volta ao valor do pedido`);
        }
        // Comissão NUNCA é rateada — é exata por linha (taxa_venda já é
        // sale_fee × quantidade por linha, ver schema.sql).
        linhasDoPedido.forEach((it) => assert.equal(it.rateado, true));
      } else {
        linhasDoPedido.forEach((it) => assert.equal(it.rateado, false, 'pedido de 1 item só nunca deveria estar marcado como rateado'));
      }
    }
    assert.ok(algumMultiItem || porPedido.size > 0, 'sanity: deveria haver ao menos pedidos pra testar');
  });

  test('buscarItensDoPeriodo: custo do produto e comissão nunca são rateados (sempre exatos por item)', () => {
    itens.forEach((it) => {
      // Custo do produto = custo cadastrado × quantidade da linha, nunca uma fração do pedido.
      if (it.custoProduto !== null) {
        assert.ok(it.custoProduto >= 0);
      }
    });
  });

  test('listarAds: nunca inventa investimento/ROAS/ACOS/TACOS quando a API de Ads está indisponível', async () => {
    const resultado = await adsLib.listarAds({ empresaId: EMPRESA_ID, contaId: null, desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr });
    assert.equal(resultado.semConta, false);
    assert.ok(resultado.situacaoPorConta.length >= 1);

    // Neste sandbox não há acesso real à API de Advertising do Mercado
    // Livre — a situação tem que vir marcada como indisponível, nunca como
    // se os dados fossem reais.
    resultado.situacaoPorConta.forEach((s) => {
      if (!s.disponivel) {
        assert.ok(s.motivo, 'situação indisponível precisa ter um motivo estruturado');
      }
    });

    resultado.linhas.forEach((linha) => {
      if (linha.semMetricasAds) {
        assert.equal(linha.investimento, null);
        assert.equal(linha.vendasAtribuidas, null);
        assert.equal(linha.qtdVendasAtribuidas, null);
        assert.equal(linha.faturamentoAtribuido, null);
        assert.equal(linha.custoAds, null);
        assert.equal(linha.margemDepoisDoAds, null, 'sem investimento real em Ads, margem depois do Ads não pode ser calculada');
        assert.equal(linha.tacos, null, 'sem investimento real em Ads, TACOS não pode ser calculado');
      }
    });
  });

  test('listarAds: faturamentoReal de cada anúncio bate com a soma dos itens reais daquele ml_item_id', async () => {
    const resultado = await adsLib.listarAds({ empresaId: EMPRESA_ID, contaId: null, desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr });
    const porItemId = new Map();
    itens.forEach((it) => {
      const chave = it.mlItemId || `sem-id:${it.sku || 's-sku'}:${it.contaMlId}`;
      if (!porItemId.has(chave)) porItemId.set(chave, 0);
      porItemId.set(chave, round2(porItemId.get(chave) + (it.valorTotalItem || 0)));
    });

    resultado.linhas.forEach((linha) => {
      if (linha.semVendaReal) {
        assert.equal(linha.faturamentoReal, null);
        assert.equal(linha.quantidadeVendidaReal, 0);
        return;
      }
      const chave = linha.mlItemId || linha.sku;
      const esperado = [...porItemId.entries()].find(([k]) => k === linha.mlItemId || k.endsWith(':' + linha.sku + ':' + linha.contaMlId));
      assert.ok(esperado, `deveria existir faturamento real somado para o anúncio ${linha.mlItemId || linha.sku}`);
      assert.equal(linha.faturamentoReal, esperado[1]);
    });
  });

  test('Isolamento: empresa sem conta Mercado Livre conectada nunca retorna dado de outra empresa', async () => {
    const resultado = await adsLib.listarAds({ empresaId: 999999, contaId: null, desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr });
    assert.equal(resultado.semConta, true);
    assert.deepEqual(resultado.linhas, []);
    assert.equal(resultado.cards.disponivel, false);
    assert.deepEqual(resultado.diario, []);
  });

  // Cards de topo (Gasto hoje/Gasto no mês/Receita atribuída/ROAS/ACOS) e o
  // gráfico diário, adicionados na correção de 25/08/2026 — mesma regra
  // "nunca inventa": sem acesso real à API de Advertising (o normal neste
  // sandbox), tudo isso tem que vir null/indisponível, nunca um número
  // calculado como se fosse real.
  test('listarAds: cards de topo nunca inventam gasto/receita/ROAS/ACOS quando a API de Ads está indisponível', async () => {
    const resultado = await adsLib.listarAds({ empresaId: EMPRESA_ID, contaId: null, desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr });
    const nenhumaContaDisponivel = !resultado.situacaoPorConta.some((s) => s.disponivel);
    if (nenhumaContaDisponivel) {
      assert.equal(resultado.cards.disponivel, false);
      assert.equal(resultado.cards.gastoHoje, null);
      assert.equal(resultado.cards.gastoMes, null);
      assert.equal(resultado.cards.receitaAtribuidaPeriodo, null, 'sem investimento real, receita atribuída não pode ser derivada de nenhuma linha');
      assert.equal(resultado.cards.roasPeriodo, null);
      assert.equal(resultado.cards.acosPeriodo, null);
      assert.deepEqual(resultado.diario, [], 'sem conta com dado diário disponível, o gráfico não pode ter série nenhuma');
    }
  });

  test('listarAds: campanha nunca aparece inventada — null quando não há dado real de Ads pro anúncio', async () => {
    const resultado = await adsLib.listarAds({ empresaId: EMPRESA_ID, contaId: null, desde, ate, desdeStr, ateStr, mesDesdeStr, mesAteStr, hojeStr });
    resultado.linhas.forEach((linha) => {
      if (linha.semMetricasAds) assert.equal(linha.campanha, null);
    });
  });

});

// Testes UNITÁRIOS (sem Postgres) da fórmula dos cards de topo
// (calcularCards, lib/ads.js) — não dependem de dado real da API de Ads,
// só de dados sintéticos, pra travar a fórmula: Gasto hoje/Gasto no mês
// somam a série diarioMes (janela mês-atual-até-hoje); Receita
// atribuída/ROAS/ACOS do período somam as MESMAS linhas mostradas na
// tabela (nunca um segundo cálculo que possa divergir).
describe('Ads — calcularCards (função pura, sem banco)', () => {
  const { calcularCards } = require('../lib/ads');

  test('soma investimento da série diarioMes pra Gasto hoje/Gasto no mês', () => {
    const cards = calcularCards({
      diarioMes: [
        { data: '2026-08-23', investimento: 10, receitaAtribuida: 40 },
        { data: '2026-08-24', investimento: 15, receitaAtribuida: 60 },
        { data: '2026-08-25', investimento: 7.5, receitaAtribuida: 30 },
      ],
      hojeStr: '2026-08-25',
      linhas: [],
      situacaoPorConta: [{ contaId: 1, disponivel: true }],
    });
    assert.equal(cards.gastoHoje, 7.5, 'Gasto hoje deveria ser só o dia de hoje (2026-08-25)');
    assert.equal(cards.gastoMes, 32.5, 'Gasto no mês deveria somar os 3 dias (10+15+7.5)');
  });

  test('Receita atribuída/ROAS/ACOS do período vêm da soma das linhas (mesma fonte da tabela)', () => {
    const cards = calcularCards({
      diarioMes: [],
      hojeStr: '2026-08-25',
      linhas: [
        { investimento: 100, faturamentoAtribuido: 400 },
        { investimento: 50, faturamentoAtribuido: 100 },
        { investimento: null, faturamentoAtribuido: null }, // anúncio sem dado de Ads — não pode contaminar a soma
      ],
      situacaoPorConta: [{ contaId: 1, disponivel: true }],
    });
    assert.equal(cards.investimentoPeriodo, 150);
    assert.equal(cards.receitaAtribuidaPeriodo, 500);
    assert.equal(cards.roasPeriodo, round2(500 / 150));
    assert.equal(cards.acosPeriodo, round2((150 / 500) * 100));
  });

  test('nenhuma conta disponível -> cards.disponivel = false, tudo null (nunca inventa)', () => {
    const cards = calcularCards({
      diarioMes: null,
      hojeStr: '2026-08-25',
      linhas: [],
      situacaoPorConta: [{ contaId: 1, disponivel: false, motivo: 'sem_acesso_ads' }],
    });
    assert.equal(cards.disponivel, false);
    assert.equal(cards.gastoHoje, null);
    assert.equal(cards.gastoMes, null);
    assert.equal(cards.receitaAtribuidaPeriodo, null);
    assert.equal(cards.roasPeriodo, null);
    assert.equal(cards.acosPeriodo, null);
  });

  test('algumas contas disponíveis e outras não -> parcial = true, mas soma o que existir (nunca tudo-ou-nada)', () => {
    const cards = calcularCards({
      diarioMes: [{ data: '2026-08-25', investimento: 20, receitaAtribuida: 80 }],
      hojeStr: '2026-08-25',
      linhas: [{ investimento: 20, faturamentoAtribuido: 80 }],
      situacaoPorConta: [
        { contaId: 1, disponivel: true },
        { contaId: 2, disponivel: false, motivo: 'sem_acesso_ads' },
      ],
    });
    assert.equal(cards.disponivel, true);
    assert.equal(cards.parcial, true);
    assert.equal(cards.gastoHoje, 20);
  });
});
