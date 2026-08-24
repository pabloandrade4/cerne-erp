// Testes automatizados da fórmula de resultado da venda (lib/resultadoVenda.js)
// — cobre o Bug 3 (desconto de cupom reduzindo a receita líquida e a base do
// imposto) da reconciliação PF ERP x Mercado Turbo (24/08/2026, ver
// docs/04-alteracoes.md), usando os valores REAIS (valorVenda, taxaVenda,
// frete, desconto) dos 4 pedidos da investigação — só o custo do produto é
// sintético (10,00, um valor qualquer), porque este arquivo testa a FÓRMULA
// isolada, sem banco. A verificação ponta a ponta com custo real e a
// contagem de pedidos do período está em relatorioVendas.integration.test.js.
// Roda com: node --test server/test/resultadoVenda.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { calcularResultadoVenda } = require('../lib/resultadoVenda');

const CUSTO_SINTETICO = 10; // qualquer valor — só pra calculoCompleto não ficar bloqueado por custo ausente

describe('Bug 3 — desconto de cupom (payments[].coupon_amount) reduz receita líquida e base do imposto', () => {
  // Pedido real 2000018077005362: valorVenda=35.34 (order.total_amount),
  // taxaVenda=1.74 (sale_fee, quantity=1), desconto=1.77 (coupon_amount do
  // pagamento aprovado) — exatamente a diferença de R$1,77 observada na
  // reconciliação com o Mercado Turbo.
  test('receita líquida = valorVenda - desconto, e o imposto usa essa base líquida', () => {
    const r = calcularResultadoVenda({
      valorVenda: 35.34,
      taxaVenda: 1.74,
      pagamentoTaxas: 0,
      pagamentoTaxaMarketplace: 0,
      freteVendedor: 7.95,
      custoProduto: CUSTO_SINTETICO,
      aliquotaImposto: 6,
      desconto: 1.77,
    });
    assert.equal(r.valorVendaLiquido, 33.57); // 35.34 - 1.77
    assert.equal(r.imposto, 2.01); // round2(33.57 * 6%)
    assert.equal(r.desconto, 1.77);
    assert.equal(r.calculoCompleto, true);
    assert.equal(r.resultado, 11.87); // 33.57 - 1.74 - 7.95 - 2.01 - 10
  });

  test('sem cupom (desconto 0 ou ausente), o comportamento é idêntico ao de antes da correção', () => {
    const comZero = calcularResultadoVenda({
      valorVenda: 100, taxaVenda: 10, pagamentoTaxas: 0, pagamentoTaxaMarketplace: 0,
      freteVendedor: 5, custoProduto: 20, aliquotaImposto: 6, desconto: 0,
    });
    const semCampo = calcularResultadoVenda({
      valorVenda: 100, taxaVenda: 10, pagamentoTaxas: 0, pagamentoTaxaMarketplace: 0,
      freteVendedor: 5, custoProduto: 20, aliquotaImposto: 6,
    });
    assert.deepEqual(comZero, semCampo);
    assert.equal(comZero.valorVendaLiquido, 100);
  });

  test('desconto nunca bloqueia calculoCompleto (ausência de cupom é 0 de verdade, não "pendente")', () => {
    const r = calcularResultadoVenda({
      valorVenda: 50, taxaVenda: 5, pagamentoTaxas: 0, pagamentoTaxaMarketplace: 0,
      freteVendedor: 3, custoProduto: 8, aliquotaImposto: 6,
    });
    assert.equal(r.calculoCompleto, true);
  });

  test('regra "nunca inventar valor" continua valendo: falta de frete/custo ainda bloqueia o resultado', () => {
    const semFrete = calcularResultadoVenda({
      valorVenda: 50, taxaVenda: 5, pagamentoTaxas: 0, pagamentoTaxaMarketplace: 0,
      freteVendedor: null, custoProduto: 8, aliquotaImposto: 6, desconto: 1,
    });
    assert.equal(semFrete.calculoCompleto, false);
    assert.equal(semFrete.resultado, null);
  });
});

describe('Pedido de kit compartilhado (Bug 1 + Bug 2 juntos, pedido real 2000018075073530)', () => {
  test('frete rateado (7,95) e comissão sem desconto entram certo na margem', () => {
    // valorVenda e taxaVenda reais desse pedido (visto no seed/DB de teste:
    // ml_order_id 2000018075073530 → valor_total 43.00 (unit_price da API),
    // taxa_venda_total 2.36, frete_vendedor já rateado 7.95, sem cupom.
    const r = calcularResultadoVenda({
      valorVenda: 43,
      taxaVenda: 2.36,
      pagamentoTaxas: 0,
      pagamentoTaxaMarketplace: 0,
      freteVendedor: 7.95,
      custoProduto: CUSTO_SINTETICO,
      aliquotaImposto: 6,
      desconto: 0,
    });
    assert.equal(r.imposto, 2.58); // round2(43 * 6%)
    assert.equal(r.resultado, 20.11); // 43 - 2.36 - 7.95 - 2.58 - 10
  });
});
