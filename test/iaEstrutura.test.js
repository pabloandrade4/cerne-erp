// Testes de lib/ia/estrutura.js — os adaptadores determinísticos que
// transformam a SAÍDA JÁ REAL de uma ferramenta (lib/ia/ferramentas.js) num
// card visual (resumo/KPIs/tabela/gráfico). Testado isolado, sem banco e
// sem provedor de IA: cada teste passa uma saída de ferramenta sintética
// (no mesmo formato que ferramentas.js realmente devolve) e confere que
// todo número no resultado é EXATAMENTE o mesmo valor de entrada — nunca
// arredondado, recalculado ou trocado.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { montarEstrutura } = require('../lib/ia/estrutura');

const EMPRESA = { id: 900, nome: 'Empresa Teste' };
const PERIODO = { chave: '30d', label: 'Últimos 30 dias', desde: new Date('2026-07-26T03:00:00Z'), ate: new Date('2026-08-25T12:00:00Z') };

function base(chamadas, apresentacaoInput) {
  return montarEstrutura({ empresa: EMPRESA, periodoCalc: PERIODO, perguntaTexto: 'pergunta de teste', chamadas, apresentacaoInput });
}

describe('lib/ia/estrutura — montarEstrutura', () => {
  test('sem apresentar_analise (pergunta simples): devolve null — resposta continua só texto', () => {
    const chamadas = [{ nome: 'resumo_vendas', input: {}, saida: { faturamento: { valor: 100, valorFormatado: 'R$ 100,00' } } }];
    assert.equal(base(chamadas, null), null);
  });

  test('resumo_vendas com apresentar_analise: KPIs presentes, sem tabela/gráfico (nada pra listar)', () => {
    const saida = {
      faturamento: { valor: 15000.5, valorFormatado: 'R$ 15.000,50' },
      margemContribuicao: { valor: 3000, valorFormatado: 'R$ 3.000,00' },
      margemContribuicaoPercentual: 20,
      quantidadePedidos: 42,
    };
    const estrutura = base([{ nome: 'resumo_vendas', input: {}, saida }], { insights: ['Vendas estáveis no período.'] });
    assert.ok(estrutura);
    assert.equal(estrutura.tabela, null);
    assert.deepEqual(estrutura.graficos, []);
    const faturamentoKpi = estrutura.kpis.find((k) => k.label === 'Faturamento');
    assert.equal(faturamentoKpi.valor, 15000.5);
    assert.equal(faturamentoKpi.valorFormatado, 'R$ 15.000,50');
    assert.deepEqual(estrutura.insights, ['Vendas estáveis no período.']);
    assert.equal(estrutura.atencao, null);
  });

  test('produtos_por_caixa_desempenho: tabela + KPIs "maior faturamento"/"maior volume" + gráfico de barras — mesmos números da entrada, byte a byte', () => {
    const saida = {
      criterio: 'caixas',
      produtosBase: [
        { produtoBase: 'CX-20X20X20', caixasFisicasVendidas: 22850, kitsVendidos: 22850, faturamento: 39691.04, faturamentoFormatado: 'R$ 39.691,04', quantidadePedidos: 900 },
        { produtoBase: 'CX-16X11X8', caixasFisicasVendidas: 32350, kitsVendidos: 32350, faturamento: 26366.29, faturamentoFormatado: 'R$ 26.366,29', quantidadePedidos: 700 },
      ],
      totalProdutosBaseNoPeriodo: 2,
    };
    const estrutura = base([{ nome: 'produtos_por_caixa_desempenho', input: {}, saida }], { tituloConversa: 'Análise de caixas', insights: ['CX-20X20X20 liderou o faturamento.', 'CX-16X11X8 vendeu mais unidades físicas.'] });

    assert.equal(estrutura.titulo, 'Análise de caixas');
    const maiorFat = estrutura.kpis.find((k) => k.label === 'Maior faturamento');
    assert.equal(maiorFat.valor, 39691.04);
    assert.equal(maiorFat.destaque, 'CX-20X20X20');
    const maiorVol = estrutura.kpis.find((k) => k.label === 'Maior volume');
    assert.equal(maiorVol.destaque, 'CX-16X11X8');

    assert.equal(estrutura.tabela.linhas.length, 2);
    assert.deepEqual(estrutura.tabela.linhas[0], { produtoBase: 'CX-20X20X20', caixas: 22850, faturamento: 39691.04, pedidos: 900 });

    assert.equal(estrutura.graficos.length, 1);
    assert.deepEqual(estrutura.graficos[0].categorias, ['CX-20X20X20', 'CX-16X11X8']);
    assert.deepEqual(estrutura.graficos[0].series[0].valores, [39691.04, 26366.29]);

    assert.equal(estrutura.insights.length, 2);
    assert.equal(estrutura.resumo.itens.length <= 4, true);
  });

  test('fluxo_de_caixa: KPIs sempre separam REALIZADO de PROJETADO (grupo)', () => {
    const saida = {
      realizado: {
        recebidoDeContasAReceberNoPeriodo: { valor: 5000, valorFormatado: 'R$ 5.000,00' },
        pagoDeContasAPagarNoPeriodo: { valor: 2000, valorFormatado: 'R$ 2.000,00' },
      },
      previstoOuProjetado: {
        contasAReceberEmAberto: { valor: 8000, valorFormatado: 'R$ 8.000,00' },
        contasAPagarEmAberto: { valor: 3000, valorFormatado: 'R$ 3.000,00' },
        contasAReceberProximos7Dias: { valor: 1000, valorFormatado: 'R$ 1.000,00' },
        contasAReceberAtrasadas: { valor: 0, valorFormatado: 'R$ 0,00' },
        contasAPagarProximos7Dias: { valor: 500, valorFormatado: 'R$ 500,00' },
        contasAPagarVencidas: { valor: 0, valorFormatado: 'R$ 0,00' },
        recebimentosMercadoLivreEsperadosNoPeriodo: { valor: null, valorFormatado: null, disponivel: false, pedidosSemEssaInformacao: 0 },
      },
      saldoProjetado: { valor: null, disponivel: false, motivo: 'sem_saldo_bancario_cadastrado' },
    };
    const estrutura = base([{ nome: 'fluxo_de_caixa', input: {}, saida }], { insights: ['Fluxo positivo no período.'] });
    const grupos = estrutura.kpis.map((k) => k.grupo);
    assert.ok(grupos.includes('REALIZADO'));
    assert.ok(grupos.includes('PROJETADO'));
    assert.equal(estrutura.graficos[0].categorias.length, 2);
  });

  test('projecao_mes (faturamento): quando indisponível (sem venda no mês), nunca inventa um número pra KPI', () => {
    const saida = { disponivel: false, motivo: 'sem_venda_no_mes_ainda', metrica: 'faturamento' };
    const estrutura = base([{ nome: 'projecao_mes', input: {}, saida }], { insights: ['Sem venda registrada ainda este mês.'] });
    // adaptador devolve null (nada a mostrar) — resumo/kpis ficam vazios, nunca um valor inventado.
    assert.equal(estrutura.kpis.length, 0);
    assert.equal(estrutura.tabela, null);
  });

  test('duas ferramentas na mesma pergunta: KPIs se combinam (sem duplicar rótulo) e a tabela mais rica é escolhida', () => {
    const saidaResumo = { faturamento: { valor: 100, valorFormatado: 'R$ 100,00' }, margemContribuicao: { valor: 20, valorFormatado: 'R$ 20,00' }, margemContribuicaoPercentual: 20, quantidadePedidos: 3 };
    const saidaProdutos = {
      criterio: 'lucro',
      produtos: [
        { sku: 'A', quantidadeVendida: 5, faturamento: 60, faturamentoFormatado: 'R$ 60,00', margemContribuicao: 10, margemContribuicaoFormatada: 'R$ 10,00' },
        { sku: 'B', quantidadeVendida: 3, faturamento: 40, faturamentoFormatado: 'R$ 40,00', margemContribuicao: 5, margemContribuicaoFormatada: 'R$ 5,00' },
      ],
      totalSkusVendidosNoPeriodo: 2, skusSemMargemCalculavel: 0,
    };
    const estrutura = base([
      { nome: 'resumo_vendas', input: {}, saida: saidaResumo },
      { nome: 'produtos_desempenho', input: {}, saida: saidaProdutos },
    ], { insights: ['Resumo geral do período.'] });

    const labels = estrutura.kpis.map((k) => k.label);
    assert.equal(new Set(labels).size, labels.length, 'nenhum rótulo de KPI duplicado');
    assert.ok(labels.includes('Faturamento'));
    assert.ok(labels.includes('Maior faturamento'));
    assert.equal(estrutura.tabela.linhas.length, 2); // veio de produtos_desempenho (só ela tem tabela)
  });
});
