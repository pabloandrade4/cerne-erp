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

  // 15/09/2026 — margem de conforto (ver lib/promocoesMotor.js#classificar):
  // o motivo explica QUAL mínimo foi exigido, nunca esconde que uma
  // exigência extra entrou em jogo pra promoções com desconto real.
  test('nao_recomendado com margem de conforto ativa (desconto real) -> motivo explica o mínimo exigido, não só o configurado', () => {
    const r = sugerirAcaoPromocao({
      classificacaoCodigo: 'nao_recomendado', statusItemMl: 'candidate', margemRealPct: 16,
      margemMinimaPctUsada: 14, margemConfortoPctUsada: 5, temDesconto: true,
    });
    assert.match(r.motivo, /conforto/);
    assert.match(r.motivo, /19/); // 14 + 5
  });

  test('entrar com margem de conforto ativa -> motivo menciona a margem de conforto exigida', () => {
    const r = sugerirAcaoPromocao({
      classificacaoCodigo: 'entrar', statusItemMl: 'candidate', margemRealPct: 20,
      margemMinimaPctUsada: 14, margemConfortoPctUsada: 5, temDesconto: true,
    });
    assert.match(r.motivo, /conforto/);
  });

  test('entrar SEM desconto (preço cheio) -> motivo não menciona conforto, mesmo com margemConfortoPctUsada configurada', () => {
    const r = sugerirAcaoPromocao({
      classificacaoCodigo: 'entrar', statusItemMl: 'candidate', margemRealPct: 20,
      margemMinimaPctUsada: 14, margemConfortoPctUsada: 5, temDesconto: false,
    });
    assert.doesNotMatch(r.motivo, /conforto/);
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

// 20/09/2026 — "risco_margem" agora tem dois motivos possíveis (ver
// lib/promocoesMotor.js#classificar — mesma tolerância dos 3 pontos que já
// valia pra ENTRAR, confirmado pelo usuário, agora também vale pra MANTER
// uma promoção ativa). O texto explica QUAL dos dois motivos foi.
describe('sugerirAcaoPromocao — risco_margem: dois motivos possíveis, texto explica qual', () => {
  test('perto do mínimo absoluto (sem cair da margem normal): motivo fala em "próxima do mínimo"', () => {
    const r = sugerirAcaoPromocao({
      classificacaoCodigo: 'risco_margem', statusItemMl: 'started', margemRealPct: 15,
      margemMinimaPctUsada: 14, precoPromo: 80, margemNormalPct: 15.5,
    });
    assert.match(r.motivo, /próxima do mínimo/);
    assert.doesNotMatch(r.motivo, /margem normal/);
  });

  test('caiu mais de 3 pontos abaixo da margem normal (mesmo longe do mínimo absoluto): motivo fala na margem normal, não em "próxima do mínimo"', () => {
    const r = sugerirAcaoPromocao({
      classificacaoCodigo: 'risco_margem', statusItemMl: 'started', margemRealPct: 20,
      margemMinimaPctUsada: 14, precoPromo: 80, margemNormalPct: 50,
    });
    assert.match(r.motivo, /margem normal/);
    assert.match(r.motivo, /30\.0 pontos/);
    assert.doesNotMatch(r.motivo, /próxima do mínimo/);
  });
});

// 20/09/2026 — pedido explícito do usuário: "sobre, meu estoque daquele
// produto estiver alto, quero que me avise". Sinal independente da margem:
// nunca muda a classificação/tipoAcao decidido pela margem, só soma
// contexto — exceto no caso "manter", onde vira o próprio motivo da
// sugestão existir.
describe('sugerirAcaoPromocao — estoque alto (pedido do usuário, 20/09/2026)', () => {
  test('manter + estoque alto -> nova sugestão "estoque_alto" (antes não gerava sugestão nenhuma)', () => {
    const r = sugerirAcaoPromocao({
      classificacaoCodigo: 'manter', statusItemMl: 'started', margemRealPct: 25, margemMinimaPctUsada: 14,
      estoqueAlto: true, motivoEstoqueAlto: 'No ritmo de vendas dos últimos 90 dias, esse estoque dura 90 dias — acima do limite configurado (60 dias).',
      coberturaDiasEstoque: 90, estoqueAtual: 500,
    });
    assert.equal(r.tipoAcao, 'estoque_alto');
    assert.match(r.motivo, /estoque dura 90 dias/);
    assert.equal(r.valorSugeridoIa.acao, 'considerar_promocao_por_estoque');
    assert.equal(r.valorSugeridoIa.coberturaDiasEstoque, 90);
    assert.equal(r.valorSugeridoIa.estoqueAtual, 500);
  });

  test('manter SEM estoque alto -> continua sem sugestão nenhuma (nada mudou aqui)', () => {
    const r = sugerirAcaoPromocao({
      classificacaoCodigo: 'manter', statusItemMl: 'started', margemRealPct: 25, margemMinimaPctUsada: 14,
      estoqueAlto: false,
    });
    assert.equal(r, null);
  });

  test('estoque alto NUNCA muda a classificação/ação decidida pela margem: entrar_promocao continua entrar_promocao, só soma explicação', () => {
    const r = sugerirAcaoPromocao({
      classificacaoCodigo: 'entrar', statusItemMl: 'candidate', margemRealPct: 18, margemMinimaPctUsada: 14, precoPromo: 90,
      estoqueAlto: true, motivoEstoqueAlto: 'Nenhuma venda registrada nos últimos 90 dias, mas ainda há 40 unidade(s) em estoque.',
    });
    assert.equal(r.tipoAcao, 'entrar_promocao');
    assert.match(r.motivo, /Nenhuma venda registrada/);
  });

  test('estoque alto também aparece no motivo de sair_promocao', () => {
    const r = sugerirAcaoPromocao({
      classificacaoCodigo: 'sair', statusItemMl: 'started', margemRealPct: 2, margemMinimaPctUsada: 14,
      estoqueAlto: true, motivoEstoqueAlto: 'estoque dura 90 dias — acima do limite configurado (60 dias).',
    });
    assert.equal(r.tipoAcao, 'sair_promocao');
    assert.match(r.motivo, /estoque dura 90 dias/);
  });
});
