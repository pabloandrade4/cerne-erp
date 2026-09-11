// Testes automatizados dos Bugs 1 e 2 da reconciliação PF ERP x Mercado
// Turbo (24/08/2026 — ver docs/04-alteracoes.md) — funções puras de
// lib/mlSync.js, usando os pedidos REAIS da conta PFEMBALAGEMS buscados no
// Supabase de produção durante a investigação (server/test/fixtures/
// real-orders.json). Não precisa de banco nem de rede — roda com:
//   node --test server/test/mlSync.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  extrairFreteDoCustosEnvio,
  ratearValor,
  calcularTaxaVendaItem,
  calcularTaxaVendaTotal,
} = require('../lib/mlSync');

const ML_USER_ID = 2486380051;
const orders = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/real-orders.json'), 'utf8'));
const porId = Object.fromEntries(orders.map((o) => [String(o.ml_order_id), o]));

describe('Bug 1 — frete de envio compartilhado (carrinho com 2+ pedidos)', () => {
  test('extrai o custo bruto do frete (comprador e vendedor) de /shipments/{id}/costs', () => {
    const { custosEnvio } = porId['2000018075073530'];
    const { freteComprador, freteVendedor } = extrairFreteDoCustosEnvio(custosEnvio, ML_USER_ID);
    assert.equal(freteVendedor, 15.9);
    assert.equal(freteComprador, 0.99);
  });

  test('pedidos 2000018075073530 e 2000018075078724 têm o MESMO ml_shipping_id/custosEnvio (confirma a causa raiz)', () => {
    const a = porId['2000018075073530'];
    const b = porId['2000018075078724'];
    assert.equal(a.order.shipping.id, b.order.shipping.id);
    assert.deepEqual(a.custosEnvio, b.custosEnvio);
  });

  test('Teste 3 (pedido do usuário): frete rateado por 2 pedidos no mesmo envio dá R$7,95 cada', () => {
    const { freteVendedor } = extrairFreteDoCustosEnvio(porId['2000018075073530'].custosEnvio, ML_USER_ID);
    assert.equal(ratearValor(freteVendedor, 2), 7.95);
    assert.equal(round2x2(7.95, 2), 15.9); // 2 pedidos x 7,95 = os 15,90 originais — nada "sumiu" nem foi duplicado
  });

  test('pedido sozinho no próprio envio (sem carrinho) não é dividido — divisor 1', () => {
    const { freteVendedor } = extrairFreteDoCustosEnvio(porId['2000018077005362'].custosEnvio, ML_USER_ID);
    assert.equal(ratearValor(freteVendedor, 1), freteVendedor);
  });

  test('frete ausente (custosEnvio indisponível) continua null — nunca estimado', () => {
    assert.equal(ratearValor(null, 2), null);
  });
});

describe('Bug 2 — comissão (sale_fee) é por unidade, não por linha', () => {
  test('Teste 1: pedido com quantidade 1 não muda (unitário == total da linha)', () => {
    const it = porId['2000018077005362'].order.order_items[0];
    assert.equal(it.quantity, 1);
    assert.equal(calcularTaxaVendaItem(it.sale_fee, it.quantity), it.sale_fee);
  });

  test('Teste 2 (pedido real 2000018078185798, quantity=2): comissão total é sale_fee x quantidade', () => {
    const it = porId['2000018078185798'].order.order_items[0];
    assert.equal(it.quantity, 2);
    assert.equal(it.sale_fee, 5.66);
    assert.equal(calcularTaxaVendaItem(it.sale_fee, it.quantity), 11.32);
    assert.equal(calcularTaxaVendaTotal(porId['2000018078185798'].order.order_items), 11.32);
  });

  test('vale para os 4 pedidos reais da investigação, incluindo um CANCELADO (não é status-dependente)', () => {
    const casos = [
      ['2000018078185798', 11.32],
      ['2000018081695020', 4.72],
      ['2000018082412310', 6.9],
      ['2000018086572830', 4.24], // status cancelled — mesmo bug, prova que não é ligado ao status
    ];
    for (const [id, esperado] of casos) {
      const o = porId[id].order;
      assert.equal(calcularTaxaVendaTotal(o.order_items), esperado, `pedido ${id}`);
    }
  });

  test('item sem sale_fee numérico não quebra o total (fica de fora, não vira 0 nem derruba o pedido)', () => {
    assert.equal(calcularTaxaVendaItem(null, 2), null);
    assert.equal(calcularTaxaVendaTotal([{ sale_fee: null, quantity: 2 }, { sale_fee: 3, quantity: 2 }]), 6);
  });
});

function round2x2(v, n) {
  return Math.round(v * n * 100) / 100;
}
