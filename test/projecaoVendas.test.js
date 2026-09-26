// Projeção de vendas do mês corrente — 26/09/2026 (ver lib/ia/projecaoVendas.js).
// Só testa a parte PURA (calcularProjecaoMes) — a orquestração
// (projetarVendasDoMes) precisa de Postgres real e já reaproveita
// buscarPedidosDoPeriodo/resumirPeriodo, cobertos pelos próprios testes de
// lib/relatorioVendas.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calcularProjecaoMes } = require('../lib/ia/projecaoVendas');

test('mês recém-começado (1 dia decorrido, 29 restantes): projeta realizado + tendência × dias restantes', () => {
  const r = calcularProjecaoMes({
    faturamentoRealizado: 500,
    diasDecorridos: 1,
    diasRestantes: 29,
    mediaDiariaProjetada: 500,
  });
  assert.equal(r.projecaoRestante, 14500);
  assert.equal(r.projecaoTotalMes, 15000);
});

test('mês já terminando (0 dias restantes): projeção total é exatamente o realizado, sem somar nada', () => {
  const r = calcularProjecaoMes({
    faturamentoRealizado: 12345.67,
    diasDecorridos: 30,
    diasRestantes: 0,
    mediaDiariaProjetada: 800,
  });
  assert.equal(r.projecaoRestante, 0);
  assert.equal(r.projecaoTotalMes, 12345.67);
});

test('empresa sem nenhuma venda ainda (realizado e tendência 0): projeção total fica 0, nunca null/erro', () => {
  const r = calcularProjecaoMes({
    faturamentoRealizado: 0,
    diasDecorridos: 5,
    diasRestantes: 25,
    mediaDiariaProjetada: 0,
  });
  assert.equal(r.projecaoTotalMes, 0);
});

test('faturamentoRealizado null (resumirPeriodo devolve null quando não há nenhum pedido) nunca vira NaN', () => {
  const r = calcularProjecaoMes({
    faturamentoRealizado: null,
    diasDecorridos: 10,
    diasRestantes: 20,
    mediaDiariaProjetada: 100,
  });
  assert.equal(r.faturamentoRealizado, 0);
  assert.equal(r.projecaoTotalMes, 2000);
});
