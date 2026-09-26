// Clientes Novos e Recorrentes — 26/09/2026 (ver lib/clientesNovosRecorrentes.js).
// Só a parte PURA (classificarClientesPorPeriodo/agregarPorCanal) — a
// orquestração (analisarClientesNovosRecorrentes) precisa de Postgres real
// e já reaproveita buscarPedidosDoPeriodo, coberto pelos testes de
// lib/relatorioVendas.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classificarClientesPorPeriodo, agregarPorCanal } = require('../lib/clientesNovosRecorrentes');

function pedido(marketplace, compradorRef, dataEfetiva) {
  return { marketplace, compradorRef, dataEfetiva };
}

const DESDE = new Date('2026-09-01T00:00:00Z');
const ATE = new Date('2026-10-01T00:00:00Z');

describe('classificarClientesPorPeriodo', () => {
  test('cliente sem NENHUMA compra anterior ao período -> novo', () => {
    const pedidos = [pedido('mercado_livre', 'c1', '2026-09-10T12:00:00Z')];
    const r = classificarClientesPorPeriodo(pedidos, { desde: DESDE, ate: ATE });
    assert.equal(r.length, 1);
    assert.equal(r[0].classificacao, 'novo');
  });

  test('cliente com compra anterior há 30 dias (dentro da janela de 90) -> recorrente', () => {
    const pedidos = [
      pedido('mercado_livre', 'c1', '2026-08-11T12:00:00Z'),
      pedido('mercado_livre', 'c1', '2026-09-10T12:00:00Z'),
    ];
    const r = classificarClientesPorPeriodo(pedidos, { desde: DESDE, ate: ATE });
    assert.equal(r.length, 1);
    assert.equal(r[0].classificacao, 'recorrente');
  });

  test('cliente com compra anterior há 200 dias (fora da janela de 90) -> reativado, nunca "novo"', () => {
    const pedidos = [
      pedido('mercado_livre', 'c1', '2026-02-01T12:00:00Z'),
      pedido('mercado_livre', 'c1', '2026-09-10T12:00:00Z'),
    ];
    const r = classificarClientesPorPeriodo(pedidos, { desde: DESDE, ate: ATE });
    assert.equal(r[0].classificacao, 'reativado');
  });

  test('cliente compra 2x DENTRO do mesmo período -> conta só 1 vez, pela primeira compra do período', () => {
    const pedidos = [
      pedido('mercado_livre', 'c1', '2026-09-05T12:00:00Z'),
      pedido('mercado_livre', 'c1', '2026-09-20T12:00:00Z'),
    ];
    const r = classificarClientesPorPeriodo(pedidos, { desde: DESDE, ate: ATE });
    assert.equal(r.length, 1, 'não pode contar o mesmo cliente 2x no mesmo período');
    assert.equal(r[0].classificacao, 'novo');
  });

  test('janela customizada (ex.: 30 dias) muda o corte recorrente/reativado', () => {
    const pedidos = [
      pedido('mercado_livre', 'c1', '2026-08-01T12:00:00Z'), // 40 dias antes
      pedido('mercado_livre', 'c1', '2026-09-10T12:00:00Z'),
    ];
    const comJanela90 = classificarClientesPorPeriodo(pedidos, { desde: DESDE, ate: ATE, janelaDias: 90 });
    assert.equal(comJanela90[0].classificacao, 'recorrente');
    const comJanela30 = classificarClientesPorPeriodo(pedidos, { desde: DESDE, ate: ATE, janelaDias: 30 });
    assert.equal(comJanela30[0].classificacao, 'reativado');
  });

  test('mesmo compradorRef em canais DIFERENTES nunca é cruzado — cada canal classificado sozinho', () => {
    const pedidos = [
      pedido('mercado_livre', 'mesmo-id-123', '2026-01-01T12:00:00Z'), // histórico só no ML
      pedido('shopee', 'mesmo-id-123', '2026-09-10T12:00:00Z'), // primeira compra na Shopee
    ];
    const r = classificarClientesPorPeriodo(pedidos, { desde: DESDE, ate: ATE });
    const shopee = r.find((x) => x.marketplace === 'shopee');
    assert.equal(shopee.classificacao, 'novo', 'histórico do ML não pode "vazar" pra Shopee');
  });

  test('pedido sem compradorRef (ex.: balcão sem nome válido) nunca é classificado', () => {
    const pedidos = [pedido('balcao', null, '2026-09-10T12:00:00Z')];
    const r = classificarClientesPorPeriodo(pedidos, { desde: DESDE, ate: ATE });
    assert.equal(r.length, 0);
  });

  test('cliente que só comprou fora do período (nunca dentro) não aparece no resultado', () => {
    const pedidos = [pedido('mercado_livre', 'c1', '2026-05-01T12:00:00Z')];
    const r = classificarClientesPorPeriodo(pedidos, { desde: DESDE, ate: ATE });
    assert.equal(r.length, 0);
  });
});

describe('agregarPorCanal', () => {
  test('soma por canal e o total geral, sem cruzar canais', () => {
    const classificacoes = [
      { marketplace: 'mercado_livre', classificacao: 'novo' },
      { marketplace: 'mercado_livre', classificacao: 'recorrente' },
      { marketplace: 'shopee', classificacao: 'novo' },
      { marketplace: 'shopee', classificacao: 'reativado' },
    ];
    const { porCanal, total } = agregarPorCanal(classificacoes);
    assert.deepEqual(porCanal.mercado_livre, { novos: 1, recorrentes: 1, reativados: 0 });
    assert.deepEqual(porCanal.shopee, { novos: 1, recorrentes: 0, reativados: 1 });
    assert.deepEqual(total, { novos: 2, recorrentes: 1, reativados: 1 });
  });

  test('lista vazia nunca quebra — devolve zeros, nunca null/undefined', () => {
    const { porCanal, total } = agregarPorCanal([]);
    assert.deepEqual(porCanal, {});
    assert.deepEqual(total, { novos: 0, recorrentes: 0, reativados: 0 });
  });
});
