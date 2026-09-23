const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  calcularMediaDiariaProjetada,
  calcularStatusCompra,
  ESTOQUE_SEGURANCA_DIAS_PADRAO,
  HORIZONTE_COMPRA_DIAS_PADRAO,
} = require('../lib/ia/comprasMotor');

test('projeção sem aceleração/desaceleração usa os pesos base (40/35/25)', () => {
  // 7d: 70un (10/dia) · 14d: 140un (10/dia) · 30d: 300un (10/dia) — venda
  // constante, então a projeção ponderada deve bater com 10/dia também.
  const r = calcularMediaDiariaProjetada({ venda7d: 70, venda14d: 140, venda30d: 300 });
  assert.equal(r.mediaDiaria7, 10);
  assert.equal(r.mediaDiaria30, 10);
  assert.equal(r.acelerando, false);
  assert.equal(r.desacelerando, false);
  assert.equal(r.pesosUsados, 'base');
  assert.equal(r.mediaDiariaProjetada, 10);
});

test('aceleração forte (7 dias bem acima de 30) dá mais peso aos dias recentes', () => {
  // 7d: 140un (20/dia) vs 30d: 300un (10/dia) -> +100% de variação, acima do
  // limiar de 20% -> pesos de tendência (60/25/15), projeção puxada pra cima.
  const r = calcularMediaDiariaProjetada({ venda7d: 140, venda14d: 200, venda30d: 300 });
  assert.equal(r.acelerando, true);
  assert.equal(r.pesosUsados, 'tendencia');
  // 20*0.60 + 14.29*0.25 + 10*0.15 ≈ 17,07
  assert.ok(Math.abs(r.mediaDiariaProjetada - 17.07) < 0.5);
});

test('desaceleração forte também troca para os pesos de tendência', () => {
  const r = calcularMediaDiariaProjetada({ venda7d: 20, venda14d: 100, venda30d: 300 });
  assert.equal(r.desacelerando, true);
  assert.equal(r.pesosUsados, 'tendencia');
});

test('sem nenhuma venda no período, nunca recomenda compra (mesmo com estoque zerado)', () => {
  const r = calcularStatusCompra({
    estoqueGalpao: 0, estoqueFull: 0, estoqueACaminho: 0,
    venda7d: 0, venda14d: 0, venda30d: 0,
    prazoFornecedorDias: 7, estoqueSegurancaDiasConfigurado: null, custoUnitario: 1,
  });
  assert.equal(r.semHistoricoDeVendas, true);
  assert.equal(r.quantidadeRecomendada, 0);
  assert.equal(r.status, 'atencao'); // estoque zerado, mas sem venda pra basear nada
});

test('estoque saudável (cobertura bem acima do horizonte de 30 dias) não recomenda comprar', () => {
  const r = calcularStatusCompra({
    estoqueGalpao: 3000, estoqueFull: 0, estoqueACaminho: 0,
    venda7d: 70, venda14d: 140, venda30d: 300, // 10/dia -> 300 dias de cobertura
    prazoFornecedorDias: 7, estoqueSegurancaDiasConfigurado: null, custoUnitario: 1,
  });
  assert.equal(r.status, 'saudavel');
  assert.equal(r.quantidadeRecomendada, 0);
});

test('estoque baixo o suficiente pra cair dentro do prazo do fornecedor + segurança -> comprar agora', () => {
  // 10/dia, prazo fornecedor 7 dias, segurança padrão 7 dias -> limiar
  // "comprar agora" é cobertura <= 14 dias. Estoque de 100un = 10 dias de
  // cobertura -> deve cair em comprar_agora, não em ruptura (10 > 7).
  const r = calcularStatusCompra({
    estoqueGalpao: 100, estoqueFull: 0, estoqueACaminho: 0,
    venda7d: 70, venda14d: 140, venda30d: 300,
    prazoFornecedorDias: 7, estoqueSegurancaDiasConfigurado: null, custoUnitario: 2,
  });
  assert.equal(r.status, 'comprar_agora');
  assert.equal(r.diasCobertura, 10);
  assert.ok(r.quantidadeRecomendada > 0);
  assert.equal(r.valorEstimado, Math.round(r.quantidadeRecomendada * 2 * 100) / 100);
});

test('cobertura menor ou igual ao prazo do fornecedor -> ruptura provável', () => {
  const r = calcularStatusCompra({
    estoqueGalpao: 50, estoqueFull: 0, estoqueACaminho: 0,
    venda7d: 70, venda14d: 140, venda30d: 300, // 10/dia -> 5 dias de cobertura
    prazoFornecedorDias: 7, estoqueSegurancaDiasConfigurado: null, custoUnitario: 2,
  });
  assert.equal(r.status, 'ruptura');
  assert.equal(r.diasCobertura, 5);
});

test('mercadoria a caminho já cobre o suficiente -> status "a caminho" (azul), não recomenda comprar de novo', () => {
  const r = calcularStatusCompra({
    estoqueGalpao: 100, estoqueFull: 0, estoqueACaminho: 5000,
    venda7d: 70, venda14d: 140, venda30d: 300,
    prazoFornecedorDias: 7, estoqueSegurancaDiasConfigurado: null, custoUnitario: 2,
  });
  assert.equal(r.status, 'a_caminho');
  assert.equal(r.quantidadeRecomendada, 0);
});

test('sem fornecedor padrão cadastrado, usa prazo 0 (conservador) e avisa via prazoFornecedorIndisponivel', () => {
  const r = calcularStatusCompra({
    estoqueGalpao: 50, estoqueFull: 0, estoqueACaminho: 0,
    venda7d: 70, venda14d: 140, venda30d: 300,
    prazoFornecedorDias: null, estoqueSegurancaDiasConfigurado: null, custoUnitario: 2,
  });
  assert.equal(r.prazoFornecedorIndisponivel, true);
  // limiar ruptura agora é 0 dias (sem prazo), então 5 dias de cobertura já
  // não é mais "ruptura" e sim "comprar agora" (5 <= 0+7 de segurança).
  assert.equal(r.status, 'comprar_agora');
});

test('produto sem custo cadastrado nunca gera valor estimado inventado (fica null)', () => {
  const r = calcularStatusCompra({
    estoqueGalpao: 50, estoqueFull: 0, estoqueACaminho: 0,
    venda7d: 70, venda14d: 140, venda30d: 300,
    prazoFornecedorDias: 7, estoqueSegurancaDiasConfigurado: null, custoUnitario: null,
  });
  assert.equal(r.valorEstimado, null);
  assert.ok(r.quantidadeRecomendada > 0);
});

test('estoque de segurança específico do produto substitui o padrão global', () => {
  const comPadrao = calcularStatusCompra({
    estoqueGalpao: 200, estoqueFull: 0, estoqueACaminho: 0,
    venda7d: 70, venda14d: 140, venda30d: 300,
    prazoFornecedorDias: 7, estoqueSegurancaDiasConfigurado: null, custoUnitario: 1,
  });
  assert.equal(comPadrao.estoqueSegurancaDias, ESTOQUE_SEGURANCA_DIAS_PADRAO);

  const comCustom = calcularStatusCompra({
    estoqueGalpao: 200, estoqueFull: 0, estoqueACaminho: 0,
    venda7d: 70, venda14d: 140, venda30d: 300,
    prazoFornecedorDias: 7, estoqueSegurancaDiasConfigurado: 15, custoUnitario: 1,
  });
  assert.equal(comCustom.estoqueSegurancaDias, 15);
  // Mais dias de segurança -> ponto de recompra maior -> tende a recomendar
  // comprar mais (ou igual) do que com o padrão.
  assert.ok(comCustom.quantidadeRecomendada >= comPadrao.quantidadeRecomendada);
});

test('quantidade desejada nunca passa do horizonte de 30 dias quando o prazo do fornecedor é curto', () => {
  const r = calcularStatusCompra({
    estoqueGalpao: 0, estoqueFull: 0, estoqueACaminho: 0,
    venda7d: 70, venda14d: 140, venda30d: 300, // 10/dia
    prazoFornecedorDias: 2, estoqueSegurancaDiasConfigurado: 2, custoUnitario: 1,
  });
  // ponto de recompra (2+2=4 dias -> 40un) é menor que o horizonte de 30
  // dias (300un) -> estoque desejado deve ser o horizonte, não o ponto de
  // recompra.
  assert.equal(r.estoqueDesejadoUnidades, 10 * HORIZONTE_COMPRA_DIAS_PADRAO);
});
