// Testes PUROS de lib/ia/adsDecisor.js — Fase 1 do agente "Ads e
// Performance" (14/09/2026). Cobrem exatamente as regras determinísticas:
// só sugere ação quando há dado real suficiente, nunca inventa um valor de
// orçamento sem o orçamento atual real, e nunca sugere ação nenhuma para
// classificações "manter"/"dados_insuficientes".
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  sugerirAcaoAnuncio, sugerirEntrarEmCampanha, sugerirAcaoCampanha,
} = require('../lib/ia/adsDecisor');

describe('sugerirAcaoAnuncio', () => {
  test('classificação pausar + tem campanha -> sugere pausar_anuncio', () => {
    const r = sugerirAcaoAnuncio({ linha: { classificacaoCodigo: 'pausar', campanha: 'Campanha A', margemDepoisDoAds: -12.5 } });
    assert.equal(r.tipoAcao, 'pausar_anuncio');
    assert.match(r.motivo, /-12.50|12.50/);
  });

  test('classificação pausar mas SEM campanha -> nenhuma sugestão (pausar anúncio não se aplica)', () => {
    assert.equal(sugerirAcaoAnuncio({ linha: { classificacaoCodigo: 'pausar', campanha: null } }), null);
  });

  test('classificação diferente de pausar -> nenhuma sugestão', () => {
    assert.equal(sugerirAcaoAnuncio({ linha: { classificacaoCodigo: 'ajustar', campanha: 'X' } }), null);
    assert.equal(sugerirAcaoAnuncio({ linha: { classificacaoCodigo: 'manter', campanha: 'X' } }), null);
  });
});

describe('sugerirEntrarEmCampanha', () => {
  test('SKU orgânico com margem positiva e vendas suficientes -> sugere colocar_sku_em_campanha', () => {
    const r = sugerirEntrarEmCampanha({ linha: { campanha: null, semVendaReal: false, margemAntesDoAds: 45.9, quantidadeVendidaReal: 8 } });
    assert.equal(r.tipoAcao, 'colocar_sku_em_campanha');
  });

  test('já tem campanha -> nenhuma sugestão (não é o caso desta regra)', () => {
    assert.equal(sugerirEntrarEmCampanha({ linha: { campanha: 'Campanha A', margemAntesDoAds: 45.9, quantidadeVendidaReal: 8 } }), null);
  });

  test('margem antes do Ads negativa ou ausente -> nenhuma sugestão (nunca incentiva Ads num produto que já perde dinheiro)', () => {
    assert.equal(sugerirEntrarEmCampanha({ linha: { campanha: null, margemAntesDoAds: -5, quantidadeVendidaReal: 20 } }), null);
    assert.equal(sugerirEntrarEmCampanha({ linha: { campanha: null, margemAntesDoAds: null, quantidadeVendidaReal: 20 } }), null);
  });

  test('vendas abaixo do mínimo -> nenhuma sugestão (poucas vendas não sustentam a recomendação)', () => {
    assert.equal(sugerirEntrarEmCampanha({ linha: { campanha: null, margemAntesDoAds: 30, quantidadeVendidaReal: 2 } }), null);
  });

  test('sem venda real no período -> nenhuma sugestão', () => {
    assert.equal(sugerirEntrarEmCampanha({ linha: { campanha: null, semVendaReal: true, margemAntesDoAds: 30, quantidadeVendidaReal: 8 } }), null);
  });
});

describe('sugerirAcaoCampanha', () => {
  test('pausar + campanha ainda ativa -> sugere pausar_campanha', () => {
    const r = sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'pausar', margemDepoisDoAds: -80 }, orcamentoAtual: 100, statusCampanhaAtual: 'active' });
    assert.equal(r.tipoAcao, 'pausar_campanha');
  });

  test('pausar + campanha já pausada -> nenhuma sugestão (já está pausada)', () => {
    assert.equal(sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'pausar' }, orcamentoAtual: 100, statusCampanhaAtual: 'paused' }), null);
  });

  test('ajustar + orçamento atual conhecido -> sugere diminuir_orcamento com o valor calculado (−20%)', () => {
    const r = sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'ajustar', margemDepoisDoAdsPct: 6 }, orcamentoAtual: 150, statusCampanhaAtual: 'active' });
    assert.equal(r.tipoAcao, 'diminuir_orcamento');
    assert.equal(r.valorSugeridoIa.orcamentoAtual, 150);
    assert.equal(r.valorSugeridoIa.orcamentoSugerido, 120);
  });

  test('ajustar sem orçamento atual conhecido -> nenhuma sugestão (nunca inventa valor de orçamento)', () => {
    assert.equal(sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'ajustar' }, orcamentoAtual: null, statusCampanhaAtual: 'active' }), null);
  });

  test('escalar + orçamento atual conhecido -> sugere aumentar_orcamento com o valor calculado (+20%)', () => {
    const r = sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'escalar', margemDepoisDoAdsPct: 22 }, orcamentoAtual: 100, statusCampanhaAtual: 'active' });
    assert.equal(r.tipoAcao, 'aumentar_orcamento');
    assert.equal(r.valorSugeridoIa.orcamentoSugerido, 120);
  });

  test('escalar + campanha pausada -> sugere ativar_campanha (prioridade sobre aumentar orçamento)', () => {
    const r = sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'escalar' }, orcamentoAtual: 100, statusCampanhaAtual: 'paused' });
    assert.equal(r.tipoAcao, 'ativar_campanha');
  });

  test('manter ou dados_insuficientes -> nenhuma sugestão', () => {
    assert.equal(sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'manter' }, orcamentoAtual: 100, statusCampanhaAtual: 'active' }), null);
    assert.equal(sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'dados_insuficientes' }, orcamentoAtual: 100, statusCampanhaAtual: 'active' }), null);
  });

  test('orçamento reduzido em 20% cairia abaixo do mínimo sugerido -> usa o piso (R$5) e só sugere se ainda for menor que o atual', () => {
    const r = sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'ajustar', margemDepoisDoAdsPct: 2 }, orcamentoAtual: 5, statusCampanhaAtual: 'active' });
    assert.equal(r, null); // 5 * 0.8 = 4, mas o piso é 5 -> orcamentoSugerido (5) não é < orcamentoAtual (5) -> sem sugestão
  });

  // CORREÇÃO (14/09/2026, "estude sobre todas as métricas que tem dentro do
  // Mercado Livre" — pedido explícito do usuário): métricas novas de
  // campanha (impressão perdida por orçamento vs. ranking, ACOS de
  // referência) — ver lib/ia/adsDecisor.js.
  test('escalar + perda de impressão claramente por RANKING (não orçamento) -> nenhuma sugestão de aumentar orçamento (não deve ajudar)', () => {
    const r = sugerirAcaoCampanha({
      campanha: { classificacaoCodigo: 'escalar', margemDepoisDoAdsPct: 22 }, orcamentoAtual: 100, statusCampanhaAtual: 'active',
      impressoesPerdidasOrcamentoPct: 1.2, impressoesPerdidasRankingPct: 18,
    });
    assert.equal(r, null);
  });

  test('escalar + perda de impressão claramente por ORÇAMENTO -> sugere aumentar orçamento e cita o número real no motivo', () => {
    const r = sugerirAcaoCampanha({
      campanha: { classificacaoCodigo: 'escalar', margemDepoisDoAdsPct: 22 }, orcamentoAtual: 100, statusCampanhaAtual: 'active',
      impressoesPerdidasOrcamentoPct: 24.5, impressoesPerdidasRankingPct: 2,
    });
    assert.equal(r.tipoAcao, 'aumentar_orcamento');
    assert.match(r.motivo, /24.5%/);
  });

  test('escalar + só um dos dois sinais de impressão perdida disponível -> não bloqueia (segue a lógica normal)', () => {
    const r = sugerirAcaoCampanha({
      campanha: { classificacaoCodigo: 'escalar', margemDepoisDoAdsPct: 22 }, orcamentoAtual: 100, statusCampanhaAtual: 'active',
      impressoesPerdidasOrcamentoPct: 1.2, // sem impressoesPerdidasRankingPct — dado incompleto, nunca bloqueia sozinho
    });
    assert.equal(r.tipoAcao, 'aumentar_orcamento');
  });

  test('acosBenchmark informado -> motivo cita o ACOS de referência do Mercado Livre (ajustar e escalar)', () => {
    const rAjustar = sugerirAcaoCampanha({
      campanha: { classificacaoCodigo: 'ajustar', margemDepoisDoAdsPct: 6 }, orcamentoAtual: 150, statusCampanhaAtual: 'active',
      acosBenchmark: 18.3,
    });
    assert.match(rAjustar.motivo, /18.3%/);

    const rEscalar = sugerirAcaoCampanha({
      campanha: { classificacaoCodigo: 'escalar', margemDepoisDoAdsPct: 22 }, orcamentoAtual: 100, statusCampanhaAtual: 'active',
      acosBenchmark: 18.3,
    });
    assert.match(rEscalar.motivo, /18.3%/);
  });

  test('sem acosBenchmark -> motivo não menciona nenhum "ACOS de referência" (nunca inventa o número)', () => {
    const r = sugerirAcaoCampanha({ campanha: { classificacaoCodigo: 'ajustar', margemDepoisDoAdsPct: 6 }, orcamentoAtual: 150, statusCampanhaAtual: 'active' });
    assert.doesNotMatch(r.motivo, /referência/);
  });
});
