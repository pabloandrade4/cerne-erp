const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  calcularStatusEnvioFull,
  ESTOQUE_SEGURANCA_DIAS_PADRAO,
  PRAZO_ENVIO_FULL_DIAS_PADRAO,
} = require('../lib/ia/envioFullMotor');

test('sem nenhuma venda no período, nunca recomenda envio (mesmo com Full zerado)', () => {
  const r = calcularStatusEnvioFull({
    estoqueGalpao: 100, estoqueFull: 0,
    venda7d: 0, venda14d: 0, venda30d: 0,
    prazoEnvioFullDiasConfigurado: null, estoqueSegurancaDiasConfigurado: null,
  });
  assert.equal(r.semHistoricoDeVendas, true);
  assert.equal(r.quantidadeSugeridaEnvio, 0);
  assert.equal(r.status, 'atencao'); // Full zerado, mas sem venda pra basear nada
});

test('Full abastecido (cobertura bem acima do horizonte) -> saudável, segurar envio', () => {
  const r = calcularStatusEnvioFull({
    estoqueGalpao: 500, estoqueFull: 400,
    venda7d: 10, venda14d: 20, venda30d: 40, // ~1,33/dia -> Full cobre bem mais de 30 dias
    prazoEnvioFullDiasConfigurado: null, estoqueSegurancaDiasConfigurado: null,
  });
  assert.equal(r.status, 'saudavel');
  assert.equal(r.quantidadeSugeridaEnvio, 0);
});

test('Full baixo o suficiente pra cair dentro do prazo de envio + segurança -> enviar agora', () => {
  const r = calcularStatusEnvioFull({
    estoqueGalpao: 500, estoqueFull: 50,
    venda7d: 70, venda14d: 140, venda30d: 300, // 10/dia -> 5 dias de cobertura no Full
    prazoEnvioFullDiasConfigurado: 3, estoqueSegurancaDiasConfigurado: 5, // limiar enviar_agora = 8 dias
  });
  assert.equal(r.status, 'enviar_agora');
  assert.ok(r.quantidadeSugeridaEnvio > 0);
  assert.equal(r.semEstoqueGalpaoSuficiente, false);
});

test('Full quase zerado, dentro do prazo de envio -> ruptura (Full acabando)', () => {
  const r = calcularStatusEnvioFull({
    estoqueGalpao: 500, estoqueFull: 5,
    venda7d: 70, venda14d: 140, venda30d: 300, // 10/dia -> 0,5 dia de cobertura
    prazoEnvioFullDiasConfigurado: 3, estoqueSegurancaDiasConfigurado: 5,
  });
  assert.equal(r.status, 'ruptura');
});

test('quantidade sugerida nunca passa do que existe no Galpão — sinaliza "segurar" quando falta estoque', () => {
  const r = calcularStatusEnvioFull({
    estoqueGalpao: 2, estoqueFull: 5, // precisa enviar bem mais que 2, mas só tem 2 no Galpão
    venda7d: 70, venda14d: 140, venda30d: 300,
    prazoEnvioFullDiasConfigurado: 3, estoqueSegurancaDiasConfigurado: 5,
  });
  assert.equal(r.quantidadeSugeridaEnvio, 2); // nunca mais do que o Galpão tem
  assert.equal(r.semEstoqueGalpaoSuficiente, true);
});

test('sem configuração própria, usa os padrões globais de prazo de envio e segurança', () => {
  const r = calcularStatusEnvioFull({
    estoqueGalpao: 500, estoqueFull: 50,
    venda7d: 70, venda14d: 140, venda30d: 300,
    prazoEnvioFullDiasConfigurado: null, estoqueSegurancaDiasConfigurado: null,
  });
  assert.equal(r.prazoEnvioFullDias, PRAZO_ENVIO_FULL_DIAS_PADRAO);
  assert.equal(r.estoqueSegurancaDias, ESTOQUE_SEGURANCA_DIAS_PADRAO);
});
