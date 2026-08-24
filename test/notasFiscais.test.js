// Testes de INTEGRAÇÃO (precisa de Postgres local) de Notas Fiscais,
// ativado em 24/08/2026. Sem emissão real (SEFAZ). Usa pedidos reais da
// empresa/conta 900 — NUNCA cria pedido fictício.
//
// Como rodar:
//   DATABASE_URL=postgresql://usuario:senha@localhost:5432/cerne_dev_test \
//     node --test notasFiscais.test.js
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEM_BANCO = !!process.env.DATABASE_URL;
const EMPRESA_ID = 900;
const ML_ORDER_ID_1 = '2000018077005362';
const PEDIDO_INEXISTENTE = 999999;
const CHAVE_44 = '35260812345678000199550010000001231234567890';

describe('Notas Fiscais — 24/08/2026', { skip: !TEM_BANCO && 'defina DATABASE_URL apontando pra um Postgres de teste já seedado' }, () => {
  let notasFiscais, periodo, pool;
  let desde, ate;
  let PEDIDO_ID_1;

  before(async () => {
    notasFiscais = require('../lib/notasFiscais');
    periodo = require('../lib/periodo');
    pool = require('../db/pool');
    desde = periodo.inicioDoDiaBRTDeString('2026-08-22');
    ate = periodo.inicioDoDiaBRTDeString('2026-08-25');

    // Resolvido por ml_order_id, não por id fixo — o teste de idempotência
    // de relatorioVendas.integration.test.js apaga e recria os pedidos
    // seedados a cada execução (id novo sempre).
    const { rows } = await pool.query(
      `SELECT p.id FROM ml_pedidos p JOIN ml_contas c ON c.id = p.conta_ml_id
       WHERE c.empresa_id = $1 AND p.ml_order_id = $2`,
      [EMPRESA_ID, ML_ORDER_ID_1]
    );
    PEDIDO_ID_1 = rows[0].id;
  });

  after(async () => {
    await pool.query(`DELETE FROM notas_fiscais WHERE pedido_id = $1`, [PEDIDO_ID_1]);
  });

  test('pedido sem nota registrada aparece como "pendente", sem número/série/chave inventados', async () => {
    const { itens } = await notasFiscais.listarNotasFiscais({ empresaId: EMPRESA_ID, desde, ate });
    const item = itens.find(i => i.pedidoId === PEDIDO_ID_1);
    assert.ok(item);
    assert.equal(item.status, 'pendente');
    assert.equal(item.numero, null);
    assert.equal(item.serie, null);
    assert.equal(item.chaveAcesso, null);
    assert.equal(item.dataEmissao, null);
    assert.equal(item.mlOrderId, '2000018077005362');
  });

  test('registrarNota: rejeita status "emitida" sem número/série/data/chave — nunca finge uma emissão', async () => {
    const r = await notasFiscais.registrarNota(PEDIDO_ID_1, { status: 'emitida' });
    assert.ok(r.errors.numero);
    assert.ok(r.errors.serie);
    assert.ok(r.errors.dataEmissao);
    assert.ok(r.errors.chaveAcesso);
  });

  test('registrarNota: chave de acesso precisa ter 44 dígitos', async () => {
    const r = await notasFiscais.registrarNota(PEDIDO_ID_1, {
      status: 'emitida', numero: '123', serie: '1', dataEmissao: '2026-08-24', chaveAcesso: '12345',
    });
    assert.ok(r.errors.chaveAcesso);
  });

  test('registrarNota: pedido inexistente retorna notFound', async () => {
    const r = await notasFiscais.registrarNota(PEDIDO_INEXISTENTE, { status: 'pendente' });
    assert.ok(r.notFound);
  });

  test('registrarNota: cria como pendente, sem exigir número/chave', async () => {
    const r = await notasFiscais.registrarNota(PEDIDO_ID_1, { status: 'pendente', observacao: 'aguardando emissão no sistema fiscal' });
    assert.ok(r.nota);
    assert.equal(r.nota.status, 'pendente');
    assert.equal(r.nota.numero, null);
    assert.equal(r.nota.chave_acesso, null);
  });

  test('registrarNota: upsert por pedido — segunda chamada ATUALIZA a mesma nota, nunca cria uma segunda', async () => {
    const r = await notasFiscais.registrarNota(PEDIDO_ID_1, {
      status: 'emitida', numero: '4521', serie: '1', dataEmissao: '2026-08-24', chaveAcesso: CHAVE_44, valor: 35.34,
    });
    assert.equal(r.nota.status, 'emitida');
    assert.equal(r.nota.numero, '4521');
    assert.equal(r.nota.chave_acesso, CHAVE_44);

    const { rows } = await pool.query('SELECT count(*) FROM notas_fiscais WHERE pedido_id = $1', [PEDIDO_ID_1]);
    assert.equal(Number(rows[0].count), 1, 'nunca deveria haver mais de uma nota por pedido nesta versão');
  });

  test('a nota emitida aparece na listagem, com cliente/loja vindos do pedido (nunca duplicados na tabela)', async () => {
    const { itens } = await notasFiscais.listarNotasFiscais({ empresaId: EMPRESA_ID, desde, ate });
    const item = itens.find(i => i.pedidoId === PEDIDO_ID_1);
    assert.equal(item.status, 'emitida');
    assert.equal(item.numero, '4521');
    assert.equal(item.chaveAcesso, CHAVE_44);
    assert.ok(item.cliente); // veio do JOIN com ml_pedidos, não de uma coluna duplicada em notas_fiscais
  });

  test('filtro por status e busca por número da nota', async () => {
    const porStatus = await notasFiscais.listarNotasFiscais({ empresaId: EMPRESA_ID, desde, ate, status: 'emitida' });
    assert.ok(porStatus.itens.some(i => i.pedidoId === PEDIDO_ID_1));
    assert.ok(porStatus.itens.every(i => i.status === 'emitida'));

    const porBusca = await notasFiscais.listarNotasFiscais({ empresaId: EMPRESA_ID, desde, ate, search: '4521' });
    assert.equal(porBusca.itens.length, 1);
    assert.equal(porBusca.itens[0].pedidoId, PEDIDO_ID_1);
  });

  test('registrarNota: valor precisa ser maior que zero quando informado', async () => {
    const r = await notasFiscais.registrarNota(PEDIDO_ID_1, { status: 'pendente', valor: -10 });
    assert.ok(r.errors.valor);
  });
});
