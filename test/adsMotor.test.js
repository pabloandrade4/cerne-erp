// Testes PUROS de lib/ia/adsMotor.js — IA de Ads e Performance, Fase A
// (14/09/2026). Cobrem exatamente o que o usuário pediu: classificar
// desempenho de forma determinística/explicável (nunca uma "caixa preta"),
// nunca fabricar dado quando falta custo/métrica de Ads (dados_insuficientes),
// e somar (nunca recalcular) os números reais de cada anúncio pro resumo por
// campanha.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classificarDesempenho, agregarPorCampanha } = require('../lib/ia/adsMotor');

describe('classificarDesempenho — regras determinísticas, mesmo espírito de promocoesMotor#classificar', () => {
  test('margemDepoisDoAdsPct null -> DADOS INSUFICIENTES (nunca inventa)', () => {
    const r = classificarDesempenho({ margemDepoisDoAdsPct: null, margemMinimaPct: 10 });
    assert.equal(r.codigo, 'dados_insuficientes');
  });

  test('resultado negativo após Ads -> PAUSAR, mesmo com margemMinimaPct baixa', () => {
    const r = classificarDesempenho({ margemDepoisDoAdsPct: -3, margemMinimaPct: 5 });
    assert.equal(r.codigo, 'pausar');
  });

  test('positivo mas abaixo do mínimo configurado -> AJUSTAR', () => {
    const r = classificarDesempenho({ margemDepoisDoAdsPct: 6, margemMinimaPct: 10 });
    assert.equal(r.codigo, 'ajustar');
  });

  test('dentro do saudável, sem folga de 1.5x -> MANTER', () => {
    const r = classificarDesempenho({ margemDepoisDoAdsPct: 12, margemMinimaPct: 10 });
    assert.equal(r.codigo, 'manter');
  });

  test('margem folgada (>= 1.5x o mínimo) -> ESCALAR', () => {
    const r = classificarDesempenho({ margemDepoisDoAdsPct: 16, margemMinimaPct: 10 });
    assert.equal(r.codigo, 'escalar');
  });

  test('margemMinimaPct = 0: usa os limites padrão (20% pra folga)', () => {
    assert.equal(classificarDesempenho({ margemDepoisDoAdsPct: 1, margemMinimaPct: 0 }).codigo, 'manter');
    assert.equal(classificarDesempenho({ margemDepoisDoAdsPct: 25, margemMinimaPct: 0 }).codigo, 'escalar');
  });
});

describe('agregarPorCampanha — soma números reais por campanha, nunca recalcula a fórmula', () => {
  test('soma investimento/faturamento/margem de 2 anúncios da mesma campanha e reclassifica no agregado', () => {
    const linhas = [
      { campanha: 'Campanha A', loja: 'Loja X', contaMlId: 1, investimento: 100, faturamentoAtribuido: 400, faturamentoReal: 500, margemDepoisDoAds: 40 },
      { campanha: 'Campanha A', loja: 'Loja X', contaMlId: 1, investimento: 50, faturamentoAtribuido: 100, faturamentoReal: 150, margemDepoisDoAds: 20 },
    ];
    const [c] = agregarPorCampanha(linhas, 10);
    assert.equal(c.campanha, 'Campanha A');
    assert.equal(c.qtdAnuncios, 2);
    assert.equal(c.investimento, 150);
    assert.equal(c.faturamentoAtribuido, 500);
    assert.equal(c.faturamentoReal, 650);
    assert.equal(c.margemDepoisDoAds, 60);
    // margemDepoisDoAdsPct = 60/650*100 ≈ 9.23 -> abaixo de 10 -> AJUSTAR
    assert.equal(c.classificacaoCodigo, 'ajustar');
  });

  test('anúncio sem campanha (venda 100% orgânica, sem Ads) fica de fora do resumo', () => {
    const linhas = [{ campanha: null, contaMlId: 1, investimento: null, faturamentoAtribuido: null, faturamentoReal: 200, margemDepoisDoAds: 50 }];
    assert.equal(agregarPorCampanha(linhas, 10).length, 0);
  });

  test('um anúncio da campanha com margem incompleta (custo faltando) marca a campanha inteira como dados insuficientes', () => {
    const linhas = [
      { campanha: 'Campanha B', contaMlId: 1, investimento: 100, faturamentoAtribuido: 300, faturamentoReal: 300, margemDepoisDoAds: 30 },
      { campanha: 'Campanha B', contaMlId: 1, investimento: 50, faturamentoAtribuido: 100, faturamentoReal: 100, margemDepoisDoAds: null },
    ];
    const [c] = agregarPorCampanha(linhas, 10);
    assert.equal(c.margemDepoisDoAdsPct, null);
    assert.equal(c.classificacaoCodigo, 'dados_insuficientes');
  });

  test('duas contas com campanha de mesmo nome não se misturam (chave por contaMlId + campanha)', () => {
    const linhas = [
      { campanha: 'Oferta', contaMlId: 1, investimento: 10, faturamentoAtribuido: 50, faturamentoReal: 50, margemDepoisDoAds: 5 },
      { campanha: 'Oferta', contaMlId: 2, investimento: 20, faturamentoAtribuido: 60, faturamentoReal: 60, margemDepoisDoAds: 6 },
    ];
    const resultado = agregarPorCampanha(linhas, 10);
    assert.equal(resultado.length, 2);
  });
});
