// Testes de INTEGRAÇÃO (precisa de Postgres local) do Faturamento, ativado
// em 24/08/2026. Usa os pedidos reais da empresa/conta 900 (mesmos da
// reconciliação PF ERP x Mercado Turbo) — NUNCA cria pedido fictício, só
// muda a situação de faturamento de pedidos que já existem de verdade.
//
// Como rodar:
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test faturamento.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;
// Pedidos reais de empresa 900 (ver docs/04-alteracoes.md — reconciliação
// PF ERP x Mercado Turbo): 2000018075073530 (pago) e 2000018075078724
// (pago). Resolvidos por ml_order_id em vez de id fixo — o teste de
// idempotência de relatorioVendas.integration.test.js apaga e recria os
// pedidos seedados (id novo a cada reprocessamento), então o id numérico
// nunca pode ser hardcoded entre execuções.
const ML_ORDER_ID_1 = '2000018075073530';
const ML_ORDER_ID_2 = '2000018075078724';
const PEDIDO_INEXISTENTE = 999999;

describe('Faturamento — 24/08/2026', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let faturamento, periodo, pool;
  let desde, ate;
  let PEDIDO_ID_1, PEDIDO_ID_2;

  before(async () => {
    faturamento = require('../lib/faturamento');
    periodo = require('../lib/periodo');
    pool = require('../db/pool');
    desde = periodo.inicioDoDiaBRTDeString('2026-08-22');
    ate = periodo.inicioDoDiaBRTDeString('2026-08-25');

    const { rows } = await pool.query(
      `SELECT p.id, p.ml_order_id FROM ml_pedidos p JOIN ml_contas c ON c.id = p.conta_ml_id
       WHERE c.empresa_id = $1 AND p.ml_order_id = ANY($2::bigint[])`,
      [EMPRESA_ID, [ML_ORDER_ID_1, ML_ORDER_ID_2]]
    );
    PEDIDO_ID_1 = rows.find((r) => String(r.ml_order_id) === ML_ORDER_ID_1).id;
    PEDIDO_ID_2 = rows.find((r) => String(r.ml_order_id) === ML_ORDER_ID_2).id;
  });

  after(async () => {
    await pool.query(`DELETE FROM faturamento_pedidos WHERE pedido_id = ANY($1::int[])`, [[PEDIDO_ID_1, PEDIDO_ID_2]]);
    await pool.end();
  });

  test('pedido sem linha em faturamento_pedidos aparece como "aguardando_faturamento" por padrão', async () => {
    const { itens } = await faturamento.listarFaturamento({ empresaId: EMPRESA_ID, desde, ate });
    assert.ok(itens.length >= 10, 'deveria listar os pedidos reais da empresa 900 no período');
    const item = itens.find(i => i.pedidoId === PEDIDO_ID_1);
    assert.ok(item);
    assert.equal(item.situacaoFaturamento, 'aguardando_faturamento');
    assert.equal(item.marketplace, 'Mercado Livre');
    assert.equal(item.mlOrderId, '2000018075073530');
  });

  test('atualizarSituacao: status inválido é rejeitado', async () => {
    const r = await faturamento.atualizarSituacao(PEDIDO_ID_1, { status: 'invalido' });
    assert.ok(r.errors.status);
  });

  test('atualizarSituacao: pedido inexistente retorna notFound', async () => {
    const r = await faturamento.atualizarSituacao(PEDIDO_INEXISTENTE, { status: 'faturado' });
    assert.ok(r.notFound);
  });

  test('atualizarSituacao: upsert nunca duplica — muda de faturado pra erro sem criar segunda linha', async () => {
    const r1 = await faturamento.atualizarSituacao(PEDIDO_ID_1, { status: 'faturado' });
    assert.equal(r1.situacao.status, 'faturado');
    const r2 = await faturamento.atualizarSituacao(PEDIDO_ID_1, { status: 'erro', observacao: 'CNPJ do cliente inválido' });
    assert.equal(r2.situacao.status, 'erro');
    assert.equal(r2.situacao.observacao, 'CNPJ do cliente inválido');

    const { rows } = await pool.query('SELECT count(*) FROM faturamento_pedidos WHERE pedido_id = $1', [PEDIDO_ID_1]);
    assert.equal(Number(rows[0].count), 1, 'nunca deveria haver mais de uma linha de situação por pedido');
  });

  test('a situação de faturamento reflete na listagem', async () => {
    const { itens } = await faturamento.listarFaturamento({ empresaId: EMPRESA_ID, desde, ate });
    const item = itens.find(i => i.pedidoId === PEDIDO_ID_1);
    assert.equal(item.situacaoFaturamento, 'erro');
  });

  test('filtro por situação de faturamento', async () => {
    const { itens } = await faturamento.listarFaturamento({ empresaId: EMPRESA_ID, desde, ate, status: 'erro' });
    assert.ok(itens.some(i => i.pedidoId === PEDIDO_ID_1));
    assert.ok(itens.every(i => i.situacaoFaturamento === 'erro'));
  });

  test('busca por número do pedido', async () => {
    const { itens } = await faturamento.listarFaturamento({ empresaId: EMPRESA_ID, desde, ate, search: '2000018075073530' });
    assert.equal(itens.length, 1);
    assert.equal(itens[0].pedidoId, PEDIDO_ID_1);
  });

  test('ação em lote: atualiza vários pedidos de uma vez, reporta o que falhou', async () => {
    const r = await faturamento.atualizarSituacaoEmLote([PEDIDO_ID_1, PEDIDO_ID_2, PEDIDO_INEXISTENTE], 'faturado');
    assert.deepEqual(r.atualizados.sort(), [PEDIDO_ID_1, PEDIDO_ID_2].sort());
    assert.deepEqual(r.falharam, [PEDIDO_INEXISTENTE]);

    const { itens } = await faturamento.listarFaturamento({ empresaId: EMPRESA_ID, desde, ate });
    assert.equal(itens.find(i => i.pedidoId === PEDIDO_ID_1).situacaoFaturamento, 'faturado');
    assert.equal(itens.find(i => i.pedidoId === PEDIDO_ID_2).situacaoFaturamento, 'faturado');
  });

  test('ação em lote: status inválido é rejeitado antes de tocar em qualquer pedido', async () => {
    const r = await faturamento.atualizarSituacaoEmLote([PEDIDO_ID_1], 'status-invalido');
    assert.ok(r.errors.status);
  });

  test('ação em lote: lista vazia é rejeitada', async () => {
    const r = await faturamento.atualizarSituacaoEmLote([], 'faturado');
    assert.ok(r.errors.pedidoIds);
  });
});
