// Testes PUROS (sem banco) das 3 abas de Análise criadas em 26/08/2026:
// Performance de Anúncios, Visitas e Conversão, Margem por Anúncio. Cobre
// as funções de cálculo/classificação que não dependem de I/O — a parte que
// mistura dados reais (banco + API do Mercado Livre) é coberta por
// test/anunciosAnalise.integration.test.js (precisa de DATABASE_URL).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { periodoAnteriorEquivalente } = require('../lib/periodoComparacao');
const { calcularCrescimento, agruparVendasDetalhado, diasEntre, resolverIdentidade } = require('../lib/anunciosBase');
const { classificarIndicador } = require('../lib/performanceAnuncios');

describe('periodoComparacao — período anterior equivalente', () => {
  test('mesma duração, imediatamente anterior ao início do período', () => {
    const desde = new Date('2026-08-01T00:00:00Z');
    const ate = new Date('2026-08-08T00:00:00Z'); // 7 dias
    const anterior = periodoAnteriorEquivalente({ desde, ate });
    assert.equal(anterior.ate.getTime(), desde.getTime());
    assert.equal(anterior.desde.getTime(), new Date('2026-07-25T00:00:00Z').getTime());
    assert.equal(anterior.ate.getTime() - anterior.desde.getTime(), ate.getTime() - desde.getTime());
  });

  test('período de 1 dia (ex: "hoje") gera período anterior de 1 dia (ex: "ontem")', () => {
    const desde = new Date('2026-08-20T00:00:00-03:00');
    const ate = new Date('2026-08-21T00:00:00-03:00');
    const anterior = periodoAnteriorEquivalente({ desde, ate });
    assert.equal(anterior.desde.getTime(), new Date('2026-08-19T00:00:00-03:00').getTime());
    assert.equal(anterior.ate.getTime(), desde.getTime());
  });
});

describe('anunciosBase — calcularCrescimento', () => {
  test('sem base de comparação (anterior=0) e sem valor atual: sem percentual, não é "novo"', () => {
    const r = calcularCrescimento(0, 0);
    assert.equal(r.percentual, null);
    assert.equal(r.novo, false);
  });

  test('vendeu no atual mas nada no anterior: "novo", sem percentual inventado', () => {
    const r = calcularCrescimento(5, 0);
    assert.equal(r.percentual, null);
    assert.equal(r.novo, true);
  });

  test('crescimento normal calculado corretamente', () => {
    const r = calcularCrescimento(15, 10);
    assert.equal(r.percentual, 50);
    assert.equal(r.novo, false);
  });

  test('queda calculada corretamente (percentual negativo)', () => {
    const r = calcularCrescimento(5, 10);
    assert.equal(r.percentual, -50);
  });

  test('null é tratado como 0 (nunca quebra a conta)', () => {
    const r = calcularCrescimento(null, null);
    assert.equal(r.percentual, null);
    assert.equal(r.novo, false);
  });
});

describe('anunciosBase — agruparVendasDetalhado', () => {
  test('soma quantidade e conta pedidos DISTINTOS (não unidades) por anúncio', () => {
    const itens = [
      { pedidoId: 1, mlItemId: 'A', sku: 'SKU-A', titulo: 'Anúncio A', loja: 'Loja', contaMlId: 1, quantidade: 3, valorTotalItem: 30, tarifas: 3, freteVendedor: 2, imposto: 1, custoProduto: 10, margemContribuicao: 14, calculoCompleto: true, rateado: false },
      { pedidoId: 2, mlItemId: 'A', sku: 'SKU-A', titulo: 'Anúncio A', loja: 'Loja', contaMlId: 1, quantidade: 1, valorTotalItem: 10, tarifas: 1, freteVendedor: 1, imposto: 0.5, custoProduto: 3, margemContribuicao: 4.5, calculoCompleto: true, rateado: false },
    ];
    const agrupado = agruparVendasDetalhado(itens);
    const a = agrupado.get('A');
    assert.equal(a.quantidade, 4);
    assert.equal(a.quantidadePedidos, 2, 'dois pedidos distintos, mesmo anúncio');
    assert.equal(a.faturamento, 40);
    assert.equal(a.margemContribuicao, 18.5);
    assert.equal(a.margemIncompleta, false);
  });

  test('um pedido com 2 unidades do mesmo anúncio conta como 1 pedido, não 2', () => {
    const itens = [
      { pedidoId: 9, mlItemId: 'B', sku: 'SKU-B', titulo: 'B', loja: 'L', contaMlId: 1, quantidade: 2, valorTotalItem: 20, tarifas: 2, freteVendedor: 1, imposto: 1, custoProduto: 5, margemContribuicao: 11, calculoCompleto: true, rateado: false },
    ];
    const agrupado = agruparVendasDetalhado(itens);
    assert.equal(agrupado.get('B').quantidade, 2);
    assert.equal(agrupado.get('B').quantidadePedidos, 1);
  });

  test('custo ausente marca margemIncompleta=true e não soma um valor parcial como se fosse completo', () => {
    const itens = [
      { pedidoId: 1, mlItemId: 'C', sku: 'SKU-C', titulo: 'C', loja: 'L', contaMlId: 1, quantidade: 1, valorTotalItem: 10, tarifas: 1, freteVendedor: 1, imposto: 0.5, custoProduto: null, margemContribuicao: null, calculoCompleto: false, rateado: false },
    ];
    const agrupado = agruparVendasDetalhado(itens);
    const c = agrupado.get('C');
    assert.equal(c.margemIncompleta, true);
    assert.equal(c.margemContribuicao, null);
    assert.equal(c.custoProduto, null, 'custo ausente fica null, nunca 0 (0 seria um valor inventado)');
    assert.equal(c.pendentes, 1);
  });
});

describe('anunciosBase — diasEntre', () => {
  test('conta dias corridos entre duas datas', () => {
    const a = new Date('2026-08-01T00:00:00Z');
    const b = new Date('2026-08-15T00:00:00Z');
    assert.equal(diasEntre(a, b), 14);
  });
});

describe('anunciosBase — resolverIdentidade (mesma identidade nas 3 abas: item_id, capa/foto, SKU, loja, título)', () => {
  test('capa/foto SÓ vem do catálogo ao vivo, nunca é inventada a partir da venda', () => {
    const venda = { mlItemId: 'MLB1', sku: 'SKU-1', titulo: 'Título da venda', loja: 'Loja A', contaMlId: 1 };
    const vivo = { id: 'MLB1', sku: 'SKU-1', titulo: 'Título ao vivo', loja: 'Loja A', contaId: 1, preco: 99.9, status: 'active', imagemUrl: 'https://http2.mlstatic.com/foo.jpg' };
    const r = resolverIdentidade({ mlItemId: 'MLB1', venda, vivo });
    assert.equal(r.imagemUrl, 'https://http2.mlstatic.com/foo.jpg');
    assert.equal(r.anuncio, 'Título ao vivo', 'título ao vivo tem prioridade sobre o título da venda quando os dois existem');
    assert.equal(r.precoAtual, 99.9);
    assert.equal(r.status, 'active');
  });

  test('anúncio vendido mas fora do catálogo ao vivo (ex: encerrado há muito tempo): sem imagem, nunca uma imagem de outro anúncio', () => {
    const venda = { mlItemId: 'MLB2', sku: 'SKU-2', titulo: 'Só na venda', loja: 'Loja B', contaMlId: 2 };
    const r = resolverIdentidade({ mlItemId: 'MLB2', venda, vivo: null });
    assert.equal(r.imagemUrl, null);
    assert.equal(r.anuncio, 'Só na venda');
    assert.equal(r.status, null);
  });

  test('anúncio vivo sem nenhuma venda no período: usa dados do catálogo ao vivo', () => {
    const vivo = { id: 'MLB3', sku: 'SKU-3', titulo: 'Vivo sem venda', loja: 'Loja C', contaId: 3, preco: 50, status: 'active', imagemUrl: 'https://x/img.jpg' };
    const r = resolverIdentidade({ mlItemId: 'MLB3', venda: null, vivo });
    assert.equal(r.imagemUrl, 'https://x/img.jpg');
    assert.equal(r.sku, 'SKU-3');
    assert.equal(r.loja, 'Loja C');
  });
});

describe('performanceAnuncios — classificarIndicador (critérios objetivos documentados)', () => {
  test('anúncio pausado/encerrado nunca recebe indicador de cor', () => {
    assert.equal(classificarIndicador({ status: 'paused', diasSemVender: 0, crescimentoPercentual: 100, unidadesVendidas: 10, unidadesAnterior: 1, mediaVendasPorDia: 1 }), null);
    assert.equal(classificarIndicador({ status: 'closed', diasSemVender: null, crescimentoPercentual: null, unidadesVendidas: 0, unidadesAnterior: 0, mediaVendasPorDia: 0 }), null);
  });

  test('🔴 baixo: 14+ dias sem vender', () => {
    const r = classificarIndicador({ status: 'active', diasSemVender: 20, crescimentoPercentual: null, unidadesVendidas: 0, unidadesAnterior: 0, mediaVendasPorDia: 0 });
    assert.equal(r, 'baixo');
  });

  test('🔴 baixo: vendia no período anterior e parou de vender', () => {
    const r = classificarIndicador({ status: 'active', diasSemVender: 5, crescimentoPercentual: null, unidadesVendidas: 0, unidadesAnterior: 8, mediaVendasPorDia: 0 });
    assert.equal(r, 'baixo');
  });

  test('🔴 baixo: queda >= 50% nas vendas vs período anterior', () => {
    const r = classificarIndicador({ status: 'active', diasSemVender: 1, crescimentoPercentual: -60, unidadesVendidas: 4, unidadesAnterior: 10, mediaVendasPorDia: 0.5 });
    assert.equal(r, 'baixo');
  });

  test('🟡 atenção: queda moderada entre 20% e 50%', () => {
    const r = classificarIndicador({ status: 'active', diasSemVender: 1, crescimentoPercentual: -30, unidadesVendidas: 7, unidadesAnterior: 10, mediaVendasPorDia: 0.9 });
    assert.equal(r, 'atencao');
  });

  test('🟡 atenção: 7 a 13 dias sem vender', () => {
    const r = classificarIndicador({ status: 'active', diasSemVender: 9, crescimentoPercentual: null, unidadesVendidas: 0, unidadesAnterior: 0, mediaVendasPorDia: 0 });
    assert.equal(r, 'atencao');
  });

  test('🟡 atenção: praticamente parado (vende, mas muito pouco)', () => {
    const r = classificarIndicador({ status: 'active', diasSemVender: 1, crescimentoPercentual: 0, unidadesVendidas: 1, unidadesAnterior: 1, mediaVendasPorDia: 0.03 });
    assert.equal(r, 'atencao');
  });

  test('🟢 bom: vendendo, sem sinais de queda/estagnação', () => {
    const r = classificarIndicador({ status: 'active', diasSemVender: 1, crescimentoPercentual: 5, unidadesVendidas: 10, unidadesAnterior: 9, mediaVendasPorDia: 1.5 });
    assert.equal(r, 'bom');
  });

  test('sem_classificacao: ativo, nunca vendeu, sem tendência pra avaliar', () => {
    const r = classificarIndicador({ status: 'active', diasSemVender: null, crescimentoPercentual: null, unidadesVendidas: 0, unidadesAnterior: 0, mediaVendasPorDia: 0 });
    assert.equal(r, 'sem_classificacao');
  });
});
