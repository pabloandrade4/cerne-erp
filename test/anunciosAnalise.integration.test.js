// Testes de INTEGRAÇÃO (precisa de Postgres local — mesmo padrão de
// test/fluxoCaixa.test.js) das 3 abas de Análise criadas em 26/08/2026:
// Performance de Anúncios, Visitas e Conversão, Margem por Anúncio. Roda as
// funções REAIS contra o banco de teste (empresa 900, com pedidos reais já
// sincronizados do Mercado Livre).
//
// A conta ML da empresa 900 está com status 'erro' neste ambiente de
// desenvolvimento (token expirado) — por isso os testes abaixo cobrem
// exatamente o comportamento esperado NESSE cenário real: nunca inventar
// preço/status/visitas quando a API ao vivo está indisponível, mostrando o
// motivo real em vez disso. Reconciliação com Pedidos/Relatórios é testada
// comparando os totais desta tela com lib/relatorioVendas.js (fonte única).
//
// Como rodar:
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev \
//     node --test anunciosAnalise.integration.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;

describe('Análise por anúncio (Performance / Visitas e Conversão / Margem) — 26/08/2026', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let performanceAnuncios, visitasConversao, margemAnuncio, relatorioVendas, periodo, pool;

  before(async () => {
    performanceAnuncios = require('../lib/performanceAnuncios');
    visitasConversao = require('../lib/visitasConversao');
    margemAnuncio = require('../lib/margemAnuncio');
    relatorioVendas = require('../lib/relatorioVendas');
    periodo = require('../lib/periodo');
    pool = require('../db/pool');
  });

  after(async () => {
    await pool.end();
  });

  function periodoDeTeste() {
    const periodoCalc = periodo.calcularPeriodo('30d');
    const { desde: desdeStr, ate: ateStr } = periodo.periodoParaDatasBRT(periodoCalc);
    return { periodoCalc, desdeStr, ateStr };
  }

  describe('Performance de Anúncios', () => {
    test('faturamento e quantidade de pedidos batem exatamente com relatorioVendas (fonte única)', async () => {
      const { periodoCalc, desdeStr, ateStr } = periodoDeTeste();
      const resultado = await performanceAnuncios.gerarPerformanceAnuncios({ empresaId: EMPRESA_ID, contaId: null, sku: null, status: null, periodoCalc, desdeStr, ateStr });
      assert.equal(resultado.semConta, false);
      assert.ok(resultado.linhas.length > 0, 'empresa 900 tem pedidos reais sincronizados — deve haver ao menos 1 anúncio');

      const somaFaturamento = resultado.linhas.reduce((s, l) => s + (l.faturamento || 0), 0);
      const { pedidos, totalNoPeriodo: _t } = await relatorioVendas.buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde: periodoCalc.desde, ate: periodoCalc.ate });
      const resumo = relatorioVendas.resumirPeriodo(pedidos);
      assert.equal(Math.round(somaFaturamento * 100), Math.round((resumo.faturamento.valor || 0) * 100), 'soma do faturamento por anúncio deve bater com o faturamento total de Pedidos/Relatórios');
    });

    test('conta com token inválido: status/preço aparecem indisponíveis, nunca inventados — e "situacaoPorConta" explica o motivo real', async () => {
      const { periodoCalc, desdeStr, ateStr } = periodoDeTeste();
      const resultado = await performanceAnuncios.gerarPerformanceAnuncios({ empresaId: EMPRESA_ID, contaId: null, sku: null, status: null, periodoCalc, desdeStr, ateStr });
      const semDado = resultado.linhas.filter((l) => l.semDadosVivos);
      assert.ok(semDado.length > 0);
      semDado.forEach((l) => assert.equal(l.precoAtual, null));
      assert.ok(resultado.situacaoPorConta.some((s) => !s.disponivel && s.motivo === 'conta_com_erro'));
    });

    test('filtro de SKU restringe as linhas retornadas', async () => {
      const { periodoCalc, desdeStr, ateStr } = periodoDeTeste();
      const todos = await performanceAnuncios.gerarPerformanceAnuncios({ empresaId: EMPRESA_ID, contaId: null, sku: null, status: null, periodoCalc, desdeStr, ateStr });
      const primeiroSku = todos.linhas.find((l) => l.sku)?.sku;
      assert.ok(primeiroSku, 'precisa de ao menos 1 anúncio com SKU pra este teste fazer sentido');
      const filtrado = await performanceAnuncios.gerarPerformanceAnuncios({ empresaId: EMPRESA_ID, contaId: null, sku: primeiroSku, status: null, periodoCalc, desdeStr, ateStr });
      assert.ok(filtrado.linhas.length <= todos.linhas.length);
      filtrado.linhas.forEach((l) => assert.ok((l.sku || '').toLowerCase().includes(primeiroSku.toLowerCase())));
    });

    test('empresa sem nenhuma conta do Mercado Livre: semConta=true, nunca uma lista vazia sem explicação', async () => {
      const { periodoCalc, desdeStr, ateStr } = periodoDeTeste();
      const resultado = await performanceAnuncios.gerarPerformanceAnuncios({ empresaId: 999999, contaId: null, sku: null, status: null, periodoCalc, desdeStr, ateStr });
      assert.equal(resultado.semConta, true);
      assert.deepEqual(resultado.linhas, []);
    });
  });

  describe('Visitas e Conversão', () => {
    test('sem token válido: visitas/conversão vêm null com dadoNaoDisponivel=true — NUNCA um número inventado', async () => {
      const { periodoCalc, desdeStr, ateStr } = periodoDeTeste();
      const resultado = await visitasConversao.gerarVisitasConversao({ empresaId: EMPRESA_ID, contaId: null, sku: null, periodoCalc, desdeStr, ateStr });
      assert.ok(resultado.linhas.length > 0);
      resultado.linhas.forEach((l) => {
        assert.equal(l.dadoNaoDisponivel, true);
        assert.equal(l.visitas, null);
        assert.equal(l.conversao, null);
      });
    });

    test('unidadesVendidas/pedidos por anúncio batem com a mesma fonte usada em Performance de Anúncios', async () => {
      const { periodoCalc, desdeStr, ateStr } = periodoDeTeste();
      const [perf, visitas] = await Promise.all([
        performanceAnuncios.gerarPerformanceAnuncios({ empresaId: EMPRESA_ID, contaId: null, sku: null, status: null, periodoCalc, desdeStr, ateStr }),
        visitasConversao.gerarVisitasConversao({ empresaId: EMPRESA_ID, contaId: null, sku: null, periodoCalc, desdeStr, ateStr }),
      ]);
      const porItemPerf = new Map(perf.linhas.filter((l) => l.mlItemId).map((l) => [l.mlItemId, l]));
      let comparados = 0;
      visitas.linhas.forEach((l) => {
        const p = l.mlItemId && porItemPerf.get(l.mlItemId);
        if (!p) return;
        assert.equal(l.unidadesVendidas, p.unidadesVendidas);
        assert.equal(l.pedidos, p.quantidadePedidos);
        comparados++;
      });
      assert.ok(comparados > 0, 'precisa comparar ao menos 1 anúncio em comum entre as duas telas');
    });
  });

  describe('Margem por Anúncio', () => {
    test('usa a MESMA fórmula/fonte de Pedidos/Financeiro (margem soma igual)', async () => {
      const { periodoCalc } = periodoDeTeste();
      const resultado = await margemAnuncio.gerarMargemPorAnuncio({ empresaId: EMPRESA_ID, contaId: null, sku: null, periodoCalc, periodoChaveAds: periodoCalc.chave });
      assert.ok(resultado.linhas.length > 0);

      const { pedidos } = await relatorioVendas.buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde: periodoCalc.desde, ate: periodoCalc.ate });
      const resumo = relatorioVendas.resumirPeriodo(pedidos);
      const somaFaturamento = resultado.linhas.reduce((s, l) => s + (l.faturamento || 0), 0);
      assert.equal(Math.round(somaFaturamento * 100), Math.round((resumo.faturamento.valor || 0) * 100));
    });

    test('SKU sem custo cadastrado: margemIncompleta=true, margemContribuicao null (nunca soma parcial como completa)', async () => {
      const { periodoCalc } = periodoDeTeste();
      const resultado = await margemAnuncio.gerarMargemPorAnuncio({ empresaId: EMPRESA_ID, contaId: null, sku: null, periodoCalc, periodoChaveAds: periodoCalc.chave });
      const semCusto = resultado.linhas.filter((l) => l.custoProdutos === null);
      assert.ok(semCusto.length > 0, 'fixture da empresa 900 tem SKUs sem custo cadastrado (ver docs/05-problemas-conhecidos.md)');
      semCusto.forEach((l) => {
        assert.equal(l.margemIncompleta, true);
        assert.equal(l.margemContribuicao, null);
      });
    });

    test('imposto nunca aparece como "ausente" — alíquota é única por empresa, sempre calculada quando há faturamento (documentado no arquivo)', async () => {
      const { periodoCalc } = periodoDeTeste();
      const resultado = await margemAnuncio.gerarMargemPorAnuncio({ empresaId: EMPRESA_ID, contaId: null, sku: null, periodoCalc, periodoChaveAds: periodoCalc.chave });
      resultado.linhas.forEach((l) => {
        if (l.faturamento > 0) assert.notEqual(l.imposto, null);
      });
    });

    test('filtro de loja (contaId) nunca mistura dados de outra conta', async () => {
      const { periodoCalc } = periodoDeTeste();
      const resultado = await margemAnuncio.gerarMargemPorAnuncio({ empresaId: EMPRESA_ID, contaId: 900, sku: null, periodoCalc, periodoChaveAds: periodoCalc.chave });
      resultado.linhas.forEach((l) => assert.equal(l.contaMlId, 900));
    });
  });
});
