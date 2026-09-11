const { test } = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../db/pool');
const { FERRAMENTAS_SCHEMA, criarContexto, executarFerramenta } = require('../lib/ia/ferramentas');

test('IA expõe ferramenta de contas a pagar por vencimento com data final obrigatória', () => {
  const ferramenta = FERRAMENTAS_SCHEMA.find((f) => f.name === 'contas_a_pagar_por_vencimento');
  assert.ok(ferramenta, 'falta a ferramenta contas_a_pagar_por_vencimento');
  assert.deepEqual(ferramenta.input_schema.required, ['ate']);
  assert.ok(ferramenta.input_schema.properties.desde);
  assert.ok(ferramenta.input_schema.properties.ate);
  assert.equal(ferramenta.input_schema.properties.empresaId, undefined, 'empresa nunca pode ser escolhida pelo modelo');
});

test('"quanto preciso pagar até 10/09" consulta pendentes da empresa até a data e inclui vencidas', async () => {
  const originalQuery = pool.query;
  const chamadas = [];
  pool.query = async (sql, params) => {
    chamadas.push({ sql: String(sql), params });
    if (/COUNT\(\*\)/i.test(sql)) {
      return { rows: [{ quantidade: '3', total: '1250.50' }] };
    }
    return {
      rows: [
        { id: 1, documento: '9048', descricao: 'Boleto antigo', categoria: 'Fornecedores', valor: '250.50', vencimento: new Date('2026-08-20T00:00:00Z'), fornecedor_nome: 'Fornecedor A' },
        { id: 2, documento: '9050', descricao: 'Boleto CR 9050', categoria: 'Fornecedores', valor: '600.00', vencimento: new Date('2026-09-04T00:00:00Z'), fornecedor_nome: 'Fornecedor B' },
        { id: 3, documento: '9051', descricao: 'Boleto CR 9051', categoria: 'Fornecedores', valor: '400.00', vencimento: new Date('2026-09-10T00:00:00Z'), fornecedor_nome: null },
      ],
    };
  };

  try {
    const ctx = criarContexto({ empresaId: 77, periodoChave: '30d' });
    const resultado = await executarFerramenta('contas_a_pagar_por_vencimento', { ate: '2026-09-10' }, ctx);

    assert.equal(resultado.erro, undefined, resultado.erro);
    assert.equal(resultado.total.valor, 1250.50);
    assert.equal(resultado.quantidadeContas, 3);
    assert.deepEqual(resultado.intervalo, { desde: null, ate: '2026-09-10' });
    assert.equal(resultado.contas[0].vencimento, '2026-08-20');
    assert.equal(resultado.contas[1].cr, '9050');

    assert.equal(chamadas.length, 2);
    for (const chamada of chamadas) {
      assert.equal(chamada.params[0], 77, 'empresa deve vir somente do contexto/header');
      assert.match(chamada.sql, /status\s*=\s*'pendente'/i);
      assert.match(chamada.sql, /vencimento\s*<=/i, '"até" precisa incluir todas as contas até a data final');
      assert.doesNotMatch(chamada.sql, /vencimento\s*>=/i, '"até" sem data inicial precisa incluir também contas vencidas/atrasadas');
    }
    assert.ok(!chamadas.some((c) => c.params.includes(ctx.desdeStr) || c.params.includes(ctx.ateStr)), 'período do cabeçalho não pode limitar vencimento explícito');
  } finally {
    pool.query = originalQuery;
  }
});

test('intervalo explícito usa desde e até e rejeita intervalo invertido', async () => {
  const originalQuery = pool.query;
  const chamadas = [];
  pool.query = async (sql, params) => {
    chamadas.push({ sql: String(sql), params });
    if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ quantidade: '1', total: '100.00' }] };
    return { rows: [{ id: 10, documento: null, descricao: 'Conta', categoria: null, valor: '100.00', vencimento: '2026-09-05', fornecedor_nome: null }] };
  };

  try {
    const ctx = criarContexto({ empresaId: 88, periodoChave: 'hoje' });
    const ok = await executarFerramenta('contas_a_pagar_por_vencimento', { desde: '2026-09-01', ate: '2026-09-10' }, ctx);
    assert.equal(ok.erro, undefined, ok.erro);
    assert.deepEqual(ok.intervalo, { desde: '2026-09-01', ate: '2026-09-10' });
    assert.ok(chamadas.every((c) => c.params.includes('2026-09-01') && c.params.includes('2026-09-10')));

    const invalido = await executarFerramenta('contas_a_pagar_por_vencimento', { desde: '2026-09-11', ate: '2026-09-10' }, ctx);
    assert.match(invalido.erro || '', /data inicial.*posterior|intervalo/i);
  } finally {
    pool.query = originalQuery;
  }
});

test('system prompt manda usar a consulta por vencimento quando a pergunta trouxer data específica', () => {
  const { montarSystemPrompt } = require('../lib/ia/orchestrator');
  const prompt = montarSystemPrompt({
    empresa: { id: 77, nome: 'Empresa Teste' },
    periodoCalc: { label: 'Últimos 30 dias', desde: new Date('2026-07-30T03:00:00Z'), ate: new Date('2026-08-29T03:00:00Z') },
  });
  assert.match(prompt, /contas_a_pagar_por_vencimento/);
  assert.match(prompt, /data.*vencimento|vencimento.*data/i);
  assert.match(prompt, /período do cabeçalho.*não/i);
});
