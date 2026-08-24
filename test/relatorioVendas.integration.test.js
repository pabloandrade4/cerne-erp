// Teste de INTEGRAÇÃO (precisa de um Postgres local de verdade — não roda
// em CI/ambiente sem banco) dos Bugs 3 e 4 da reconciliação PF ERP x
// Mercado Turbo (24/08/2026, ver docs/04-alteracoes.md), e do Teste 6
// (idempotência) pedido pelo usuário. Roda as consultas REAIS de
// lib/relatorioVendas.js (buscarPedidosDoPeriodo, resumirPeriodo) contra os
// 11 pedidos reais da conta PFEMBALAGEMS (server/test/fixtures/real-orders.json).
//
// Como preparar e rodar (uma vez, num Postgres local vazio ou de teste):
//   createdb cerne_dev_test   # ou outro nome/host — ajuste DATABASE_URL
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     psql "$DATABASE_URL" -f ../db/schema.sql
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node fixtures/gerar-seed-sql.js | psql "$DATABASE_URL" -f -
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test relatorioVendas.integration.test.js
//
// Se DATABASE_URL não estiver definida, os testes deste arquivo são pulados
// (não falham) — pra não quebrar quem rodar `node --test` sem banco.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const CONTA_ML_ID = 900;
const EMPRESA_ID = 900;

describe('Bugs 3 e 4 — pedidos reais, banco de teste seedado', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado (ver comentário no topo do arquivo)' }, () => {
  let buscarPedidosDoPeriodo, resumirPeriodo, inicioDoDiaBRTDeString, pedidos23;

  before(async () => {
    ({ buscarPedidosDoPeriodo, resumirPeriodo } = require('../lib/relatorioVendas'));
    ({ inicioDoDiaBRTDeString } = require('../lib/periodo'));
    const desde = inicioDoDiaBRTDeString('2026-08-23');
    const ate = new Date(desde.getTime() + 24 * 60 * 60 * 1000);
    const resultado = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde, ate });
    pedidos23 = resultado.pedidos;
  });

  test('Bug 4: pedido criado em 22/08 mas fechado/pago em 23/08 aparece no período de 23/08', () => {
    const pedido = pedidos23.find((p) => p.mlOrderId === '2000018066590190');
    assert.ok(pedido, 'pedido 2000018066590190 deveria aparecer no período de 23/08 (data_fechamento), mesmo criado em 22/08');
    assert.equal(pedido.dataCriacao.slice(0, 10), '2026-08-22');
    assert.equal(pedido.dataEfetiva.slice(0, 10), '2026-08-23');
  });

  test('Bug 3: desconto de cupom bate exatamente com os 4 valores da reconciliação', () => {
    const esperado = {
      '2000018077005362': 1.77,
      '2000018078186456': 1.67,
      '2000018082460366': 1.77,
      '2000018086627042': 2.67, // dois pagamentos: 0.86 + 1.81
    };
    for (const [id, valor] of Object.entries(esperado)) {
      const pedido = pedidos23.find((p) => p.mlOrderId === id);
      assert.ok(pedido, `pedido ${id} não encontrado no período`);
      assert.equal(pedido.desconto, valor, `desconto do pedido ${id}`);
    }
  });

  test('pedidos sem cupom têm desconto 0 (não null/pendente)', () => {
    const pedido = pedidos23.find((p) => p.mlOrderId === '2000018075073530');
    assert.equal(pedido.desconto, 0);
  });

  test('resumirPeriodo soma os descontos do período (Total de descontos do relatório)', () => {
    const resumo = resumirPeriodo(pedidos23);
    assert.equal(resumo.desconto.valor, 7.88); // 1.77+1.67+1.77+2.67
  });

  test('Bug 1: pedidos do mesmo carrinho (2000018075073530/2000018075078724) têm R$7,95 de frete cada', () => {
    const a = pedidos23.find((p) => p.mlOrderId === '2000018075073530');
    const b = pedidos23.find((p) => p.mlOrderId === '2000018075078724');
    assert.equal(a.freteVendedor, 7.95);
    assert.equal(b.freteVendedor, 7.95);
  });

  test('Bug 2: comissão dos 4 pedidos reais é sale_fee x quantidade (inclui 1 cancelado)', () => {
    const esperado = {
      '2000018078185798': 11.32,
      '2000018081695020': 4.72,
      '2000018082412310': 6.9,
      '2000018086572830': 4.24,
    };
    for (const [id, valor] of Object.entries(esperado)) {
      const pedido = pedidos23.find((p) => p.mlOrderId === id);
      assert.ok(pedido, `pedido ${id} não encontrado`);
      assert.equal(pedido.tarifasMl, valor, `comissão/tarifas do pedido ${id}`);
    }
  });

  test('Teste 6 (idempotência): reprocessar o seed (simula ressincronizar) não duplica nem muda os totais', async () => {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const seedSql = execFileSync('node', [path.join(__dirname, 'fixtures/gerar-seed-sql.js')], { encoding: 'utf8' });
    execFileSync('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: seedSql });

    const desde = inicioDoDiaBRTDeString('2026-08-23');
    const ate = new Date(desde.getTime() + 24 * 60 * 60 * 1000);
    const { pedidos: pedidosDepois, totalNoPeriodo } = await buscarPedidosDoPeriodo({ empresaId: EMPRESA_ID, desde, ate });

    assert.equal(totalNoPeriodo, 11); // mesmo total, nada duplicado
    const resumoAntes = resumirPeriodo(pedidos23);
    const resumoDepois = resumirPeriodo(pedidosDepois);
    assert.equal(resumoDepois.faturamento.valor, resumoAntes.faturamento.valor);
    assert.equal(resumoDepois.tarifas.valor, resumoAntes.tarifas.valor);
    assert.equal(resumoDepois.freteVendedor.valor, resumoAntes.freteVendedor.valor);
    assert.equal(resumoDepois.desconto.valor, resumoAntes.desconto.valor);
  });
});
