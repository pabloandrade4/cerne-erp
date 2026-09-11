const { test } = require('node:test');
const assert = require('node:assert/strict');

function somarDiasISO(iso, dias) {
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y,m-1,d));
  dt.setUTCDate(dt.getUTCDate()+dias);
  return dt.toISOString().slice(0,10);
}

function dateLocalDeISO(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(y, m-1, d, 0, 0, 0, 0);
}

test('contas a pagar preserva vencimento DATE do Postgres como YYYY-MM-DD', () => {
  const poolPath = require.resolve('../db/pool');
  const contasPath = require.resolve('../lib/contasPagar');
  const oldPool = require.cache[poolPath];
  const oldContas = require.cache[contasPath];
  require.cache[poolPath] = { id:poolPath, filename:poolPath, loaded:true, exports:{ query:async()=>({rows:[]}) } };
  delete require.cache[contasPath];
  const contasPagar = require('../lib/contasPagar');
  const vencimento = '2026-09-04';
  const conta = contasPagar.serialize({
    id: 1,
    empresa_id: 1,
    fornecedor_id: null,
    descricao: 'Boleto CR 9050',
    categoria: 'Fornecedores',
    valor: '150.00',
    vencimento: dateLocalDeISO(vencimento),
    data_pagamento: null,
    status: 'pendente',
    observacao: null,
    documento: '9050',
    created_at: new Date(),
    updated_at: new Date(),
  }, '2026-08-28');

  try {
    assert.equal(conta.vencimento, vencimento);
  } finally {
    if (oldPool) require.cache[poolPath]=oldPool; else delete require.cache[poolPath];
    if (oldContas) require.cache[contasPath]=oldContas; else delete require.cache[contasPath];
  }
});

test('fluxo de caixa inclui conta pendente quando vencimento DATE chega como Date do Postgres', async () => {
  const poolPath = require.resolve('../db/pool');
  const contasPagarPath = require.resolve('../lib/contasPagar');
  const contasReceberPath = require.resolve('../lib/contasReceber');
  const despesasFixasPath = require.resolve('../lib/despesasFixas');
  const recebimentosPath = require.resolve('../lib/recebimentosMl');
  const fluxoPath = require.resolve('../lib/fluxoCaixa');
  const periodo = require('../lib/periodo');

  const hoje = periodo.diaBRT(new Date());
  const amanha = somarDiasISO(hoje, 1);

  const fakePool = {
    query: async (sql) => {
      if (/FROM fluxo_caixa_saldo_inicial/.test(sql)) return { rows: [] };
      if (/SELECT vencimento, valor FROM contas_pagar/.test(sql) && /status='pendente'/.test(sql)) {
        return { rows: [{ vencimento: dateLocalDeISO(amanha), valor: '321.45' }] };
      }
      if (/SELECT data_prevista, valor FROM contas_receber/.test(sql)) return { rows: [] };
      if (/SELECT data_pagamento, valor FROM contas_pagar/.test(sql)) return { rows: [] };
      if (/SELECT data_recebida, valor FROM contas_receber/.test(sql)) return { rows: [] };
      throw new Error('Query inesperada no teste: ' + sql);
    }
  };
  const fakeContasPagar = { resumoContasPagar: async () => ({ vencidas:0 }) };
  const fakeContasReceber = { resumoContasReceber: async () => ({ atrasado:0 }) };
  const fakeDespesasFixas = { listarDespesasFixas: async () => ([]), ocorrenciasNoIntervalo: () => [] };
  const fakeRecebimentos = { listarRecebimentosMl: async () => [] };

  const originals = new Map();
  for (const [p, exp] of [[poolPath,fakePool],[contasPagarPath,fakeContasPagar],[contasReceberPath,fakeContasReceber],[despesasFixasPath,fakeDespesasFixas],[recebimentosPath,fakeRecebimentos]]) {
    originals.set(p, require.cache[p]);
    require.cache[p] = { id:p, filename:p, loaded:true, exports:exp };
  }
  const oldFluxo = require.cache[fluxoPath];
  delete require.cache[fluxoPath];

  try {
    const fluxo = require('../lib/fluxoCaixa');
    const result = await fluxo.gerarFluxoDeCaixa({ empresaId: 1, periodoChave: '7d' });
    const dia = result.serieDiaria.find(d => d.dia === amanha);
    assert.ok(dia, 'amanhã precisa existir na série');
    assert.equal(dia.projetado.saidas, 321.45);
    assert.equal(result.resumoFormula.contasAPagar, 321.45);
  } finally {
    if (oldFluxo) require.cache[fluxoPath] = oldFluxo; else delete require.cache[fluxoPath];
    for (const [p, old] of originals) {
      if (old) require.cache[p] = old; else delete require.cache[p];
    }
  }
});
