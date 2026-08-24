// Gera um script SQL de seed a partir de real-orders.json (11 pedidos reais
// da conta PFEMBALAGEMS, buscados no Supabase de produção em 24/08/2026,
// durante a investigação da API da reconciliação PF ERP x Mercado Turbo —
// ver docs/04-alteracoes.md) — usado só pelos testes automatizados
// (server/test/), pra popular um Postgres local com dados REAIS e depois
// rodar as consultas de verdade de lib/relatorioVendas.js contra eles.
//
// Importante: os valores gravados (frete rateado, comissão × quantidade)
// são calculados chamando as MESMAS funções puras de lib/mlSync.js usadas
// em produção (extrairFreteDoCustosEnvio, calcularTaxaVendaTotal,
// calcularTaxaVendaItem, ratearValor) — este script não reimplementa a
// lógica dos bugs corrigidos, só simula o INSERT/UPDATE que
// importarPedidoInterno faria pedido a pedido (na ordem cronológica de
// date_created, como uma sincronização de verdade processaria).
//
// Uso: node gerar-seed-sql.js > /tmp/seed.sql && psql "$DATABASE_URL" -f /tmp/seed.sql
const fs = require('fs');
const path = require('path');
const { extrairFreteDoCustosEnvio, calcularTaxaVendaTotal, calcularTaxaVendaItem } = require('../../lib/mlSync');

const CONTA_ML_ID = 900;
const ML_USER_ID = 2486380051;

const orders = JSON.parse(fs.readFileSync(path.join(__dirname, 'real-orders.json'), 'utf8'));
orders.sort((a, b) => new Date(a.order.date_created) - new Date(b.order.date_created));

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function sqlNum(v) {
  return v === null || v === undefined ? 'NULL' : String(v);
}
function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlJson(v) {
  if (v === null || v === undefined) return 'NULL';
  return `$json$${JSON.stringify(v)}$json$::jsonb`;
}

const out = [];
out.push('-- GERADO por gerar-seed-sql.js — não editar à mão.');
out.push(`DELETE FROM ml_pedidos WHERE conta_ml_id = ${CONTA_ML_ID};`);

for (const { ml_order_id, order, envio, custosEnvio } of orders) {
  const { freteComprador, freteVendedor } = extrairFreteDoCustosEnvio(custosEnvio, ML_USER_ID);
  const itens = order.order_items || [];
  const taxaVendaTotal = calcularTaxaVendaTotal(itens);
  const pagamento = (order.payments && order.payments[0]) || null;

  out.push(`
INSERT INTO ml_pedidos (
  conta_ml_id, ml_order_id, pack_id, data_criacao, data_fechamento, status, status_detail,
  comprador_id, comprador_nickname, valor_total, moeda,
  ml_payment_id, pagamento_status, pagamento_taxas, pagamento_taxa_marketplace, pagamento_metodo,
  ml_shipping_id, envio_status, envio_logistic_mode, envio_logistic_type,
  frete_comprador, frete_vendedor, taxa_venda_total,
  raw_pedido, raw_envio, raw_custos_envio
) VALUES (
  ${CONTA_ML_ID}, ${ml_order_id}, ${sqlNum(order.pack_id)}, ${sqlStr(order.date_created)}, ${sqlStr(order.date_closed)}, ${sqlStr(order.status)}, ${sqlStr(order.status_detail)},
  ${sqlNum(order.buyer && order.buyer.id)}, ${sqlStr(order.buyer && order.buyer.nickname)}, ${sqlNum(num(order.total_amount))}, ${sqlStr(order.currency_id)},
  ${sqlNum(pagamento && pagamento.id)}, ${sqlStr(pagamento && pagamento.status)}, ${sqlNum(pagamento && num(pagamento.taxes_amount))}, ${sqlNum(pagamento && num(pagamento.marketplace_fee))}, ${sqlStr(pagamento && (pagamento.payment_type || pagamento.payment_method_id))},
  ${sqlNum(order.shipping && order.shipping.id)}, ${sqlStr(envio && envio.status)}, ${sqlStr(envio && envio.logistic && envio.logistic.mode)}, ${sqlStr(envio && envio.logistic && envio.logistic.type)},
  ${sqlNum(freteComprador)}, ${sqlNum(freteVendedor)}, ${sqlNum(taxaVendaTotal)},
  ${sqlJson(order)}, ${sqlJson(envio)}, ${sqlJson(custosEnvio)}
);`);

  for (const it of itens) {
    const unitPrice = num(it.unit_price);
    const fullUnitPrice = num(it.full_unit_price);
    const quantidade = num(it.quantity);
    const taxaVendaLinha = calcularTaxaVendaItem(it.sale_fee, it.quantity);
    out.push(
      `INSERT INTO ml_pedido_itens (pedido_id, ml_item_id, titulo, sku, variation_id, quantidade, preco_unitario, preco_unitario_original, valor_total_item, taxa_venda) ` +
        `SELECT id, ${sqlStr(it.item && it.item.id)}, ${sqlStr(it.item && it.item.title)}, ${sqlStr(it.item && it.item.seller_sku)}, ${sqlNum(it.item && it.item.variation_id)}, ${sqlNum(quantidade)}, ${sqlNum(unitPrice)}, ${sqlNum(fullUnitPrice)}, ${sqlNum(unitPrice != null && quantidade != null ? Math.round(unitPrice * quantidade * 100) / 100 : null)}, ${sqlNum(taxaVendaLinha)} ` +
        `FROM ml_pedidos WHERE conta_ml_id = ${CONTA_ML_ID} AND ml_order_id = ${ml_order_id};`
    );
  }

  for (const pg of order.payments || []) {
    out.push(
      `INSERT INTO ml_pedido_pagamentos (pedido_id, ml_payment_id, status, status_detail, payment_type, payment_method_id, transaction_amount, taxes_amount, shipping_cost, marketplace_fee, coupon_amount, installments, date_approved, date_created, raw_pagamento) ` +
        `SELECT id, ${sqlNum(pg.id)}, ${sqlStr(pg.status)}, ${sqlStr(pg.status_detail)}, ${sqlStr(pg.payment_type)}, ${sqlStr(pg.payment_method_id)}, ${sqlNum(num(pg.transaction_amount))}, ${sqlNum(num(pg.taxes_amount))}, ${sqlNum(num(pg.shipping_cost))}, ${sqlNum(num(pg.marketplace_fee))}, ${sqlNum(num(pg.coupon_amount))}, ${Number.isInteger(pg.installments) ? pg.installments : 'NULL'}, ${sqlStr(pg.date_approved)}, ${sqlStr(pg.date_created)}, ${sqlJson(pg)} ` +
        `FROM ml_pedidos WHERE conta_ml_id = ${CONTA_ML_ID} AND ml_order_id = ${ml_order_id};`
    );
  }

  // Bug 1: rateio entre pedidos que compartilham ml_shipping_id — mesma
  // lógica (e mesma ordem: reprocessa depois de CADA pedido inserido) de
  // importarPedidoInterno em lib/mlSync.js.
  if (order.shipping && order.shipping.id) {
    out.push(`
DO $$
DECLARE divisor int;
BEGIN
  SELECT count(*) INTO divisor FROM ml_pedidos WHERE conta_ml_id = ${CONTA_ML_ID} AND ml_shipping_id = ${order.shipping.id};
  UPDATE ml_pedidos SET
    frete_vendedor = CASE WHEN ${sqlNum(freteVendedor)}::numeric IS NULL THEN NULL ELSE round(${sqlNum(freteVendedor)}::numeric / GREATEST(divisor, 1), 2) END,
    frete_comprador = CASE WHEN ${sqlNum(freteComprador)}::numeric IS NULL THEN NULL ELSE round(${sqlNum(freteComprador)}::numeric / GREATEST(divisor, 1), 2) END
  WHERE conta_ml_id = ${CONTA_ML_ID} AND ml_shipping_id = ${order.shipping.id};
END $$;`);
  }
}

process.stdout.write(out.join('\n') + '\n');
