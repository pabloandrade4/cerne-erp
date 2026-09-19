// Estimativa de margem líquida da Shopee ANTES do repasse real (14/09/2026,
// pedido explícito do usuário: "verificar a margem da shopee pois está
// aparecendo que só vai aparecer a margem quando cair o repasse e não é
// assim que quero que funcione, quero que apareça a margem líquida"). O
// usuário escolheu, entre as opções apresentadas, usar uma taxa fixa — e
// mandou o print da tabela oficial de comissão da Shopee (Seller Center),
// tabelada por faixa de "Valor do item":
//   até R$79,99     → 20% + R$4
//   R$80–99,99      → 14% + R$16
//   R$100–199,99    → 14% + R$20
//   R$200 em diante → 14% + R$26
// (ver TABELA_COMISSAO_SHOPEE_ESTIMADA em lib/relatorioVendas.js pra o
// texto completo da regra, incluindo as duas simplificações conhecidas:
// sem desconto de Subsídio Pix, e calculada por item.)
//
// Estes testes provam duas coisas: (1) a matemática da tabela em si
// (funções puras, sem banco), e (2) que buscarPedidosDoPeriodo só usa a
// estimativa quando NÃO existe repasse real — nunca sobrescrevendo um valor
// já confirmado (mesmo princípio de "nunca inventar" de todo o resto do
// projeto, agora aplicado a uma estimativa claramente marcada como tal via
// `comissaoEstimada`).
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;

describe('lib/relatorioVendas — estimativa de comissão da Shopee (funções puras, sem banco)', () => {
  const { estimarComissaoShopeeItem, estimarComissaoShopeePedido } = require('../lib/relatorioVendas');

  test('estimarComissaoShopeeItem: cada faixa da tabela oficial da Shopee bate exatamente', () => {
    assert.equal(estimarComissaoShopeeItem(50), 14);        // 0,20*50+4
    assert.equal(estimarComissaoShopeeItem(79.99), 20); // 0,20*79,99+4 = 19,998 → 20,00 arredondado
    assert.equal(estimarComissaoShopeeItem(80), 27.2);      // 0,14*80+16
    assert.equal(estimarComissaoShopeeItem(99.99), 30);     // 0,14*99,99+16 ≈ 30,00 (arredondado)
    assert.equal(estimarComissaoShopeeItem(100), 34);       // 0,14*100+20
    assert.equal(estimarComissaoShopeeItem(199.99), 48);    // 0,14*199,99+20 ≈ 48,00
    assert.equal(estimarComissaoShopeeItem(200), 54);       // 0,14*200+26
    assert.equal(estimarComissaoShopeeItem(1000), 166);     // 0,14*1000+26
  });

  test('estimarComissaoShopeeItem: valor nulo/indefinido nunca inventa — devolve null', () => {
    assert.equal(estimarComissaoShopeeItem(null), null);
    assert.equal(estimarComissaoShopeeItem(undefined), null);
    assert.equal(estimarComissaoShopeeItem(NaN), null);
  });

  test('estimarComissaoShopeePedido: soma a estimativa de cada item do pedido', () => {
    assert.equal(estimarComissaoShopeePedido([50, 100]), 48); // 14 + 34
    assert.equal(estimarComissaoShopeePedido([50, null, 100]), 48); // ignora item sem valor, não trava a soma
  });

  test('estimarComissaoShopeePedido: pedido sem itens (ou todos sem valor) fica null — nunca estima em cima do nada', () => {
    assert.equal(estimarComissaoShopeePedido([]), null);
    assert.equal(estimarComissaoShopeePedido(null), null);
    assert.equal(estimarComissaoShopeePedido([null, null]), null);
  });
});

describe(
  'lib/relatorioVendas — comissaoEstimada aplicada só quando falta o repasse real (Postgres real)',
  { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já com o schema aplicado' },
  () => {
    let pool;
    const EMPRESA_ID = 975;
    const CONTA_ID = 975;

    before(async () => {
      pool = require('../db/pool');
      await pool.query(
        `INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES ($1,'97575775000199','EMPRESA TESTE MARGEM ESTIMADA SHOPEE',TRUE)
         ON CONFLICT (id) DO UPDATE SET ativo = TRUE`,
        [EMPRESA_ID]
      );
      await pool.query(
        `INSERT INTO config_financeiro (empresa_id, aliquota_imposto) VALUES ($1, 0)
         ON CONFLICT (empresa_id) DO UPDATE SET aliquota_imposto = 0`,
        [EMPRESA_ID]
      );
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM shopee_pedido_itens WHERE pedido_id IN (SELECT id FROM shopee_pedidos WHERE conta_shopee_id = $1)', [CONTA_ID]);
      await pool.query('DELETE FROM shopee_pedidos WHERE conta_shopee_id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM shopee_contas WHERE id = $1', [CONTA_ID]);
      await pool.query(
        `INSERT INTO shopee_contas (id, empresa_id, shopee_shop_id, access_token_enc, refresh_token_enc, token_expires_at, status)
         VALUES ($1, $2, $3, 'x', 'x', now() + interval '3 hours', 'ativa')`,
        [CONTA_ID, EMPRESA_ID, 975001]
      );
    });

    after(async () => {
      await pool.query('DELETE FROM shopee_pedido_itens WHERE pedido_id IN (SELECT id FROM shopee_pedidos WHERE conta_shopee_id = $1)', [CONTA_ID]);
      await pool.query('DELETE FROM shopee_pedidos WHERE conta_shopee_id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM shopee_contas WHERE id = $1', [CONTA_ID]);
      await pool.query('DELETE FROM config_financeiro WHERE empresa_id = $1', [EMPRESA_ID]);
      await pool.query('DELETE FROM empresas WHERE id = $1', [EMPRESA_ID]);
      // pool.end() não é chamado aqui — mesmo motivo documentado em
      // test/shopee.test.js (pool singleton compartilhado pelo processo).
    });

    test('pedido sem repasse real, mas com itens sincronizados: margem usa a estimativa, marcada comissaoEstimada=true', async () => {
      const { rows } = await pool.query(
        `INSERT INTO shopee_pedidos (conta_shopee_id, order_sn, order_status, data_criacao, valor_total, frete_real, raw_pedido)
         VALUES ($1, 'ORD-SEM-REPASSE', 'SHIPPED', now(), 150, 10, '{}'::jsonb) RETURNING id`,
        [CONTA_ID]
      );
      const pedidoId = rows[0].id;
      await pool.query(
        `INSERT INTO shopee_pedido_itens (pedido_id, item_id, nome, sku, quantidade, valor_total_item)
         VALUES ($1, 1, 'Item teste', 'SKU-EST-1', 1, 150)`,
        [pedidoId]
      );

      const { buscarPedidosDoPeriodo } = require('../lib/relatorioVendas');
      const { pedidos } = await buscarPedidosDoPeriodo({
        empresaId: EMPRESA_ID,
        desde: new Date(Date.now() - 24 * 3600 * 1000),
        ate: new Date(Date.now() + 24 * 3600 * 1000),
      });
      const pedido = pedidos.find((p) => p.mlOrderId === 'ORD-SEM-REPASSE');
      assert.ok(pedido, 'pedido deveria aparecer no período');
      assert.equal(pedido.comissaoEstimada, true);
      // valor_total_item=150 cai na faixa R$100–199,99 → 0,14*150+20 = 41
      assert.equal(pedido.tarifasMl, 41);
      assert.equal(pedido.calculoCompleto, false, 'sem custo de produto cadastrado, a margem final continua pendente — a estimativa só resolve a comissão, não o resto');
    });

    test('pedido COM repasse real: usa o valor real, nunca a estimativa (comissaoEstimada=false)', async () => {
      const { rows } = await pool.query(
        `INSERT INTO shopee_pedidos (conta_shopee_id, order_sn, order_status, data_criacao, valor_total, frete_real, comissao_venda, taxa_transacao_pagamento, taxa_servico, raw_pedido)
         VALUES ($1, 'ORD-COM-REPASSE', 'SHIPPED', now(), 150, 10, 5.5, 1.5, 0.9, '{}'::jsonb) RETURNING id`,
        [CONTA_ID]
      );
      const pedidoId = rows[0].id;
      await pool.query(
        `INSERT INTO shopee_pedido_itens (pedido_id, item_id, nome, sku, quantidade, valor_total_item)
         VALUES ($1, 1, 'Item teste', 'SKU-EST-2', 1, 150)`,
        [pedidoId]
      );

      const { buscarPedidosDoPeriodo } = require('../lib/relatorioVendas');
      const { pedidos } = await buscarPedidosDoPeriodo({
        empresaId: EMPRESA_ID,
        desde: new Date(Date.now() - 24 * 3600 * 1000),
        ate: new Date(Date.now() + 24 * 3600 * 1000),
      });
      const pedido = pedidos.find((p) => p.mlOrderId === 'ORD-COM-REPASSE');
      assert.ok(pedido);
      assert.equal(pedido.comissaoEstimada, false);
      // real: 5.5 + 1.5 + 0.9 = 7.9 — bem diferente da estimativa (41), prova que o real venceu
      assert.equal(pedido.tarifasMl, 7.9);
    });

    test('pedido sem NENHUM item sincronizado ainda: sem repasse e sem itens, fica pendente de verdade (nunca inventa em cima do nada)', async () => {
      await pool.query(
        `INSERT INTO shopee_pedidos (conta_shopee_id, order_sn, order_status, data_criacao, valor_total, frete_real, raw_pedido)
         VALUES ($1, 'ORD-SEM-ITENS', 'SHIPPED', now(), 150, 10, '{}'::jsonb)`,
        [CONTA_ID]
      );

      const { buscarPedidosDoPeriodo } = require('../lib/relatorioVendas');
      const { pedidos } = await buscarPedidosDoPeriodo({
        empresaId: EMPRESA_ID,
        desde: new Date(Date.now() - 24 * 3600 * 1000),
        ate: new Date(Date.now() + 24 * 3600 * 1000),
      });
      const pedido = pedidos.find((p) => p.mlOrderId === 'ORD-SEM-ITENS');
      assert.ok(pedido);
      assert.equal(pedido.comissaoEstimada, false);
      assert.equal(pedido.tarifasMl, null);
    });

    test('resumirPeriodo: conta quantos pedidos (não cancelados) do resumo estão usando a comissão estimada', async () => {
      const r1 = await pool.query(
        `INSERT INTO shopee_pedidos (conta_shopee_id, order_sn, order_status, data_criacao, valor_total, frete_real, raw_pedido)
         VALUES ($1, 'ORD-RESUMO-1', 'SHIPPED', now(), 150, 10, '{}'::jsonb) RETURNING id`,
        [CONTA_ID]
      );
      await pool.query(
        `INSERT INTO shopee_pedido_itens (pedido_id, item_id, nome, sku, quantidade, valor_total_item) VALUES ($1, 1, 'Item', 'SKU-R1', 1, 150)`,
        [r1.rows[0].id]
      );
      const r2 = await pool.query(
        `INSERT INTO shopee_pedidos (conta_shopee_id, order_sn, order_status, data_criacao, valor_total, frete_real, comissao_venda, taxa_transacao_pagamento, taxa_servico, raw_pedido)
         VALUES ($1, 'ORD-RESUMO-2', 'SHIPPED', now(), 150, 10, 5.5, 1.5, 0.9, '{}'::jsonb) RETURNING id`,
        [CONTA_ID]
      );
      await pool.query(
        `INSERT INTO shopee_pedido_itens (pedido_id, item_id, nome, sku, quantidade, valor_total_item) VALUES ($1, 1, 'Item', 'SKU-R2', 1, 150)`,
        [r2.rows[0].id]
      );

      const { buscarPedidosDoPeriodo, resumirPeriodo } = require('../lib/relatorioVendas');
      const { pedidos } = await buscarPedidosDoPeriodo({
        empresaId: EMPRESA_ID,
        desde: new Date(Date.now() - 24 * 3600 * 1000),
        ate: new Date(Date.now() + 24 * 3600 * 1000),
      });
      const resumo = resumirPeriodo(pedidos);
      assert.equal(resumo.comComissaoEstimada, 1, 'só o pedido sem repasse real deveria contar');
    });
  }
);
