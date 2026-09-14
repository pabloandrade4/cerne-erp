// Testes PUROS de lib/ia/promocoesDecisor.js — Fase 1 do agente
// "Promoções" (14/09/2026). Cobre o mapeamento determinístico de cada
// classificação (lib/promocoesMotor.js) pra uma ação concreta.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { sugerirAcaoPromocao } = require('../lib/ia/promocoesDecisor');

describe('sugerirAcaoPromocao — item ainda candidato (não está na promoção)', () => {
  test('entrar -> sugere entrar_promocao', () => {
    const r = sugerirAcaoPromocao({ classificacaoCodigo: 'entrar', statusItemMl: 'candidate', margemRealPct: 18, margemMinimaPctUsada: 14, precoPromo: 90 });
    assert.equal(r.tipoAcao, 'entrar_promocao');
    assert.equal(r.valorSugeridoIa.acao, 'entrar');
  });

  test('oportunidade -> também sugere entrar_promocao (margem folgada)', () => {
    const r = sugerirAcaoPromocao({ classificacaoCodigo: 'oportunidade', statusItemMl: 'candidate', margemRealPct: 30, margemMinimaPctUsada: 14 });
    assert.equal(r.tipoAcao, 'entrar_promocao');
  });

  test('nao_recomendado -> sugere nao_entrar_promocao', () => {
    const r = sugerirAcaoPromocao({ classificacaoCodigo: 'nao_recomendado', statusItemMl: 'candidate', margemRealPct: 5, margemMinimaPctUsada: 14 });
    assert.equal(r.tipoAcao, 'nao_entrar_promocao');
  });

  test('dados_insuficientes -> nenhuma sugestão', () => {
    assert.equal(sugerirAcaoPromocao({ classificacaoCodigo: 'dados_insuficientes', statusItemMl: 'candidate' }), null);
  });
});

describe('sugerirAcaoPromocao — item já ativo na promoção', () => {
  test('sair -> sugere sair_promocao', () => {
    const r = sugerirAcaoPromocao({ classificacaoCodigo: 'sair', statusItemMl: 'started', margemRealPct: 2, margemMinimaPctUsada: 14 });
    assert.equal(r.tipoAcao, 'sair_promocao');
  });

  test('risco_margem -> sugere revisar_preco (qualitativo, sem inventar preço exato)', () => {
    const r = sugerirAcaoPromocao({ classificacaoCodigo: 'risco_margem', statusItemMl: 'started', margemRealPct: 15, margemMinimaPctUsada: 14, precoPromo: 80 });
    assert.equal(r.tipoAcao, 'revisar_preco');
    assert.equal(r.valorSugeridoIa.precoPromoAtual, 80);
    assert.equal(r.valorSugeridoIa.margemAtualPct, 15);
  });

  test('manter -> nenhuma sugestão (nada a fazer)', () => {
    assert.equal(sugerirAcaoPromocao({ classificacaoCodigo: 'manter', statusItemMl: 'started', margemRealPct: 20, margemMinimaPctUsada: 14 }), null);
  });

  test('dados_insuficientes -> nenhuma sugestão', () => {
    assert.equal(sugerirAcaoPromocao({ classificacaoCodigo: 'dados_insuficientes', statusItemMl: 'started' }), null);
  });
});

test('linha nula/ausente -> nenhuma sugestão (nunca lança erro)', () => {
  assert.equal(sugerirAcaoPromocao(null), null);
  assert.equal(sugerirAcaoPromocao(undefined), null);
});
