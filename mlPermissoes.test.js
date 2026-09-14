// Testes PUROS de lib/mlPermissoes.js — IA de Promoções, Fase A
// (13/09/2026). Cobre exatamente a regra pedida pelo usuário: nunca decidir
// "escrita disponível" sozinho a partir de heurística (o texto de `scope`
// devolvido pelo Mercado Livre é só informativo) — quem manda de verdade é
// a trava manual (config_promocoes.permite_escrita_ml).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { escopoIndicaEscrita, statusIntegracaoPromocoes, MENSAGEM_ACAO_INDISPONIVEL } = require('../lib/mlPermissoes');

describe('escopoIndicaEscrita — leitura do campo scope do Mercado Livre (informativo)', () => {
  test('scope com "write" (formato real observado: "offline_access read write") devolve true', () => {
    assert.equal(escopoIndicaEscrita('offline_access read write'), true);
  });
  test('scope só com "read" devolve false', () => {
    assert.equal(escopoIndicaEscrita('offline_access read'), false);
  });
  test('scope vazio/null/undefined devolve null (nunca token nenhum capturado ainda)', () => {
    assert.equal(escopoIndicaEscrita(null), null);
    assert.equal(escopoIndicaEscrita(undefined), null);
    assert.equal(escopoIndicaEscrita(''), null);
  });
  test('separador por vírgula também funciona (defensivo)', () => {
    assert.equal(escopoIndicaEscrita('read,write'), true);
  });
});

describe('statusIntegracaoPromocoes — a trava manual é sempre quem decide, nunca o escopo sozinho', () => {
  test('escopo sugere escrita, mas a trava está desligada: escritaDisponivel continua false', () => {
    const r = statusIntegracaoPromocoes({ escopoOauth: 'offline_access read write', permiteEscritaMl: false });
    assert.equal(r.escopoSugereEscrita, true);
    assert.equal(r.escritaDisponivel, false);
    assert.equal(r.statusLabel, 'somente_leitura');
    assert.match(r.mensagem, /acesso de leitura/);
  });

  test('escopo só de leitura e trava desligada: somente leitura, mensagem amigável', () => {
    const r = statusIntegracaoPromocoes({ escopoOauth: 'offline_access read', permiteEscritaMl: false });
    assert.equal(r.escopoSugereEscrita, false);
    assert.equal(r.escritaDisponivel, false);
  });

  test('trava ligada pelo usuário: escritaDisponivel true, mesmo que ainda não tenhamos um escopo capturado', () => {
    const r = statusIntegracaoPromocoes({ escopoOauth: null, permiteEscritaMl: true });
    assert.equal(r.escritaDisponivel, true);
    assert.equal(r.statusLabel, 'leitura_e_escrita');
    assert.match(r.mensagem, /leitura e escrita liberadas/);
  });
});

describe('MENSAGEM_ACAO_INDISPONIVEL — texto fixo pedido pelo usuário pra qualquer ação de escrita bloqueada', () => {
  test('é a mensagem exata pedida ("AÇÃO NÃO DISPONÍVEL")', () => {
    assert.match(MENSAGEM_ACAO_INDISPONIVEL, /exige permissão de escrita/);
  });
});
