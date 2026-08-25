// Testes do provedor Anthropic (lib/ia/providers/anthropic.js) — correção
// de 25/08/2026 (ver docs/02-decisoes.md e docs/04-alteracoes.md): cada
// erro HTTP tem que ser categorizado (chave_invalida/sem_credito/
// limite_uso/erro_conexao/provedor_indisponivel/erro_desconhecido) e NUNCA
// o texto técnico bruto pode vazar pro usuário — só a categoria, traduzida
// em lib/ia/orchestrator.js.
//
// Duas partes:
// 1) Testes UNITÁRIOS (sem rede) — mockam o `fetch` global pra simular cada
//    status HTTP documentado na tabela oficial da API de Mensagens
//    (https://platform.claude.com/docs/en/api/errors) e conferem a
//    categoria certa, sem depender de internet real.
// 2) Um teste de INTEGRAÇÃO AO VIVO — chama a API real da Anthropic com uma
//    chave propositalmente inválida, só pra confirmar que o formato REAL de
//    erro (`{type, error:{type, message}}`) é reconhecido pelo nosso código
//    exatamente como documentado. Descoberta desta correção: este servidor
//    CONSEGUE alcançar api.anthropic.com (diferente do que os problemas
//    conhecidos assumiam antes) — mas se algum dia isso deixar de ser
//    verdade neste ambiente, o teste se marca como skip em vez de falhar.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('lib/ia/providers/anthropic — categorização de erro (sem rede, fetch mockado)', () => {
  let anthropic;
  let fetchOriginal;

  before(() => {
    anthropic = require('../lib/ia/providers/anthropic');
    fetchOriginal = global.fetch;
  });
  after(() => {
    global.fetch = fetchOriginal;
  });

  function mockFetch(status, bodyObj) {
    global.fetch = async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => bodyObj,
    });
  }

  const CASOS = [
    { status: 401, tipo: 'authentication_error', esperado: 'chave_invalida' },
    { status: 402, tipo: 'billing_error', esperado: 'sem_credito' },
    { status: 403, tipo: 'permission_error', esperado: 'chave_invalida' },
    { status: 429, tipo: 'rate_limit_error', esperado: 'limite_uso' },
    { status: 500, tipo: 'api_error', esperado: 'provedor_indisponivel' },
    { status: 529, tipo: 'overloaded_error', esperado: 'provedor_indisponivel' },
    { status: 504, tipo: 'timeout_error', esperado: 'erro_conexao' },
    { status: 400, tipo: 'invalid_request_error', esperado: 'erro_desconhecido' },
  ];

  CASOS.forEach(({ status, tipo, esperado }) => {
    test(`status ${status} (${tipo}) -> categoria "${esperado}"`, async () => {
      mockFetch(status, { type: 'error', error: { type: tipo, message: `mensagem técnica real do provedor (${tipo})` } });
      await assert.rejects(
        () => anthropic.enviarMensagem({ apiKey: 'chave-de-teste', modelo: 'claude-sonnet-4-5-20250929', system: 's', mensagens: [], ferramentas: [] }),
        (err) => {
          assert.equal(err.categoria, esperado);
          assert.equal(err.status, status);
          assert.equal(err.tipoApi, tipo);
          assert.ok(err.message.includes(tipo), 'a mensagem técnica completa deveria estar em err.message (só pro log, nunca pro usuário)');
          return true;
        }
      );
    });
  });

  test('sem apiKey: nunca chama fetch, categoria chave_invalida', async () => {
    let chamouFetch = false;
    global.fetch = async () => { chamouFetch = true; return { ok: false, status: 401, json: async () => ({}) }; };
    await assert.rejects(
      () => anthropic.enviarMensagem({ apiKey: '', modelo: 'x', system: 's', mensagens: [], ferramentas: [] }),
      (err) => { assert.equal(err.categoria, 'chave_invalida'); assert.equal(err.semChave, true); return true; }
    );
    assert.equal(chamouFetch, false, 'sem chave, nunca deveria nem tentar chamar a API');
  });

  test('resposta 200 sem corpo JSON válido: categoria provedor_indisponivel', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('corpo não é JSON'); } });
    await assert.rejects(
      () => anthropic.enviarMensagem({ apiKey: 'k', modelo: 'x', system: 's', mensagens: [], ferramentas: [] }),
      (err) => { assert.equal(err.categoria, 'provedor_indisponivel'); return true; }
    );
  });

  test('resposta 200 válida: normaliza content/stop_reason/usage corretamente (formato real da API de Mensagens)', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: 'Olá! Sou a IA Gestora.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 42, output_tokens: 8 },
      }),
    });
    const resultado = await anthropic.enviarMensagem({ apiKey: 'k', modelo: 'x', system: 's', mensagens: [{ role: 'user', content: 'Olá' }], ferramentas: [] });
    assert.deepEqual(resultado.conteudo, [{ type: 'text', text: 'Olá! Sou a IA Gestora.' }]);
    assert.equal(resultado.pararPor, 'end_turn');
    assert.deepEqual(resultado.uso, { input_tokens: 42, output_tokens: 8 });
  });

  test('erro de rede (sem resposta HTTP nenhuma, ex: DNS/conexão recusada) também vira categoria erro_conexao', async () => {
    global.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(
      () => anthropic.enviarMensagem({ apiKey: 'k', modelo: 'x', system: 's', mensagens: [], ferramentas: [] }),
      (err) => { assert.equal(err.categoria, 'erro_conexao'); return true; }
    );
  });
});

describe('lib/ia/providers/anthropic — integração AO VIVO contra api.anthropic.com (chave inválida de propósito)', () => {
  test('chave inválida real: a API devolve 401 authentication_error, e nosso código categoriza certo', async (t) => {
    const anthropic = require('../lib/ia/providers/anthropic');
    try {
      await anthropic.enviarMensagem({
        apiKey: 'sk-ant-chave-invalida-de-teste-nao-e-real',
        modelo: 'claude-sonnet-4-5-20250929',
        system: 'teste',
        mensagens: [{ role: 'user', content: 'oi' }],
        ferramentas: [],
        maxTokens: 8,
      });
      assert.fail('deveria ter lançado um erro — a chave é propositalmente inválida');
    } catch (err) {
      if (err.categoria === 'erro_conexao' && !err.status) {
        // Este ambiente não conseguiu alcançar api.anthropic.com agora
        // (pode variar por ambiente/rede) — não falha a suíte por isso,
        // já que os testes unitários acima já cobrem a lógica de
        // categorização sem depender de rede real.
        t.skip('sem conectividade real com api.anthropic.com neste momento/ambiente');
        return;
      }
      assert.equal(err.status, 401);
      assert.equal(err.tipoApi, 'authentication_error');
      assert.equal(err.categoria, 'chave_invalida');
    }
  });
});
