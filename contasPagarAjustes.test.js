const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const poolPath = require.resolve('../db/pool');
const contasPath = require.resolve('../lib/contasPagar');
const fakePool = { query: async () => { throw new Error('query não configurada'); } };
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: fakePool };
delete require.cache[contasPath];
const contasPagar = require('../lib/contasPagar');

const originalQuery = fakePool.query;
afterEach(() => { fakePool.query = originalQuery; });

test('busca de contas a pagar inclui o código CR/documento', async () => {
  let sqlUsado = '';
  let paramsUsados = [];
  fakePool.query = async (sql, params) => {
    sqlUsado = sql;
    paramsUsados = params;
    return { rows: [{
      id: 10, empresa_id: 1, fornecedor_id: null, fornecedor_nome: null,
      fornecedor_nome_importado: null, descricao: 'Boleto fornecedor X', categoria: 'Fornecedores',
      valor: '1250.00', vencimento: '2026-09-10', data_pagamento: null,
      status: 'pendente', observacao: null, documento: '9050', parcela: null,
      data_emissao: null, forma_pagamento: null, banco_conta: null, valor_pago: null,
      importacao_id: null, created_at: new Date(), updated_at: new Date(),
    }] };
  };

  const contas = await contasPagar.listarContasPagar({
    empresaId: 1, desde: '2026-08-01', ate: '2026-08-31', search: '9050'
  });

  assert.match(sqlUsado, /cp\.documento ILIKE/i);
  assert.doesNotMatch(sqlUsado, /cp\.data_pagamento >=/i, 'uma busca direta deve localizar a CR mesmo se a conta paga estiver fora do período atual');
  assert.equal(paramsUsados.at(-1), '%9050%');
  assert.equal(contas[0].documento, '9050');
});

test('conta paga pode ser editada, inclusive CR e data de pagamento', async () => {
  const queries = [];
  let busca = 0;
  fakePool.query = async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT cp\.\*, f\.razao_social AS fornecedor_nome/.test(sql)) {
      busca++;
      return { rows: [{
        id: 20, empresa_id: 1, fornecedor_id: null, fornecedor_nome: null,
        fornecedor_nome_importado: null, descricao: busca === 1 ? 'Conta original' : 'Conta corrigida',
        categoria: 'Fornecedores', valor: busca === 1 ? '100.00' : '120.00',
        vencimento: '2026-08-20', data_pagamento: busca === 1 ? '2026-08-25' : '2026-08-27',
        status: 'pago', observacao: null, documento: busca === 1 ? '9049' : '9050', parcela: null,
        data_emissao: null, forma_pagamento: null, banco_conta: null, valor_pago: null,
        importacao_id: null, created_at: new Date(), updated_at: new Date(),
      }] };
    }
    if (/UPDATE contas_pagar SET/.test(sql)) return { rows: [{ id: 20 }] };
    throw new Error('Query inesperada: ' + sql);
  };

  const result = await contasPagar.atualizarContaPagar(20, {
    descricao: 'Conta corrigida', valor: 120, documento: '9050', dataPagamento: '2026-08-27'
  });

  assert.equal(result.errors, undefined);
  assert.equal(result.conta.statusBase, 'pago');
  assert.equal(result.conta.documento, '9050');
  assert.equal(result.conta.dataPagamento, '2026-08-27');
  const update = queries.find(q => /UPDATE contas_pagar SET/.test(q.sql));
  assert.match(update.sql, /documento = \$/);
  assert.match(update.sql, /data_pagamento = \$/);
});

test('conta cancelada continua bloqueada para edição', async () => {
  fakePool.query = async (sql) => {
    if (/SELECT cp\.\*, f\.razao_social AS fornecedor_nome/.test(sql)) {
      return { rows: [{ id: 30, empresa_id: 1, status: 'cancelado', descricao: 'Cancelada', valor: '10.00', vencimento: '2026-08-20' }] };
    }
    throw new Error('Não deveria atualizar conta cancelada.');
  };
  const result = await contasPagar.atualizarContaPagar(30, { valor: 20 });
  assert.ok(result.errors && result.errors.status);
});

test('lançamento manual aceita e grava código CR no campo documento', async () => {
  let insert = null;
  fakePool.query = async (sql, params) => {
    if (/INSERT INTO contas_pagar/.test(sql)) {
      insert = { sql, params };
      return { rows: [{ id: 40 }] };
    }
    if (/SELECT cp\.\*, f\.razao_social AS fornecedor_nome/.test(sql)) {
      return { rows: [{
        id: 40, empresa_id: 1, fornecedor_id: null, fornecedor_nome: null,
        descricao: 'Boleto CR', categoria: null, valor: '50.00', vencimento: '2026-09-01',
        data_pagamento: null, status: 'pendente', observacao: null, documento: '9050',
        created_at: new Date(), updated_at: new Date()
      }] };
    }
    throw new Error('Query inesperada: ' + sql);
  };

  const result = await contasPagar.criarContaPagar({
    empresaId: 1, descricao: 'Boleto CR', valor: 50, vencimento: '2026-09-01', documento: '9050'
  });
  assert.equal(result.conta.documento, '9050');
  assert.match(insert.sql, /documento/);
  assert.ok(insert.params.includes('9050'));
});
