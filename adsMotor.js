// IA de Ads e Performance — Fase A (14/09/2026), pedido explícito do
// usuário: "Ads e Performance" é o primeiro dos 4 agentes de IA do Mercado
// Livre (ver docs/06-proximos-passos.md — Buy Box/Competitividade, SAC e
// Pós-Venda, Ads e Performance, Risco Operacional). Escolhido pra começar
// porque TODO o dado necessário já existe e já é sincronizado em segundo
// plano (lib/ads.js + lib/adsScheduler.js) — nenhuma chamada nova à API do
// Mercado Livre, nenhuma permissão nova, e nenhum risco: este arquivo só
// ADICIONA uma classificação e um resumo por campanha em cima de números
// que já são reais (investimento, ROAS, ACOS, TACOS, margem de contribuição
// real antes/depois do Ads — todos vindos de lib/ads.js#listarAds, nunca
// recalculados aqui, nunca inventados).
//
// Mesmo padrão de lib/promocoesMotor.js#classificar: regras determinísticas
// e explicáveis (nunca uma "caixa preta" da IA), configuráveis por empresa
// via `config_ads_ia.margem_minima_pct` (mesmo espírito de
// `config_promocoes.margem_minima_pct`).
const { round2 } = require('../resultadoVenda');

// Classificação do desempenho (anúncio OU campanha — mesma regra pros dois
// níveis, já que os dois usam a mesma fórmula de margem após Ads):
//  - dados insuficientes -> falta custo do produto ou métrica de Ads ainda
//    não sincronizada; nunca dá pra confiar em nenhum número calculado
//  - PAUSAR: resultado após Ads é NEGATIVO (prejuízo de verdade)
//  - AJUSTAR: resultado é positivo, mas a margem fica abaixo do mínimo
//    configurado — funcionando, mas afinar lance/orçamento antes de escalar
//  - MANTER: margem dentro do saudável, sem folga suficiente pra recomendar
//    aumentar investimento
//  - ESCALAR: margem folgada (>= 1.5x o mínimo) — sinal de que dá pra
//    investir mais em Ads nesse anúncio/campanha
function classificarDesempenho({ margemDepoisDoAdsPct, margemMinimaPct }) {
  if (margemDepoisDoAdsPct === null || margemDepoisDoAdsPct === undefined) {
    return { codigo: 'dados_insuficientes', emoji: '⚠️', label: 'DADOS INSUFICIENTES' };
  }
  const minimo = Number(margemMinimaPct) || 0;
  const limiteFolga = minimo > 0 ? minimo * 1.5 : 20;

  if (margemDepoisDoAdsPct < 0) return { codigo: 'pausar', emoji: '🔴', label: 'PAUSAR' };
  if (margemDepoisDoAdsPct < minimo) return { codigo: 'ajustar', emoji: '🟠', label: 'AJUSTAR' };
  if (margemDepoisDoAdsPct >= limiteFolga) return { codigo: 'escalar', emoji: '🟢', label: 'ESCALAR' };
  return { codigo: 'manter', emoji: '🟡', label: 'MANTER' };
}

// Agrupa as linhas por anúncio (já devolvidas por lib/ads.js#listarAds) em
// linhas por CAMPANHA — soma os mesmos números reais (nunca recalcula a
// fórmula, só soma) e aplica a mesma classificação no nível agregado.
// Anúncios sem campanha (não estão em nenhuma campanha de Ads — ex: venda
// 100% orgânica) ficam de fora deste resumo, mas continuam aparecendo
// normalmente na tabela por anúncio da tela.
function agregarPorCampanha(linhas, margemMinimaPct) {
  const mapa = new Map();

  (linhas || []).forEach((l) => {
    if (!l.campanha) return;
    const chave = l.contaMlId + '::' + l.campanha;
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        campanha: l.campanha,
        loja: l.loja,
        contaMlId: l.contaMlId,
        qtdAnuncios: 0,
        investimento: 0,
        faturamentoAtribuido: 0,
        faturamentoReal: 0,
        margemDepoisDoAds: 0,
        temInvestimento: false,
        temFaturamentoAtribuido: false,
        temFaturamentoReal: false,
        margemIncompleta: false,
      });
    }
    const acc = mapa.get(chave);
    acc.qtdAnuncios += 1;
    if (l.investimento !== null && l.investimento !== undefined) { acc.investimento += l.investimento; acc.temInvestimento = true; }
    if (l.faturamentoAtribuido !== null && l.faturamentoAtribuido !== undefined) { acc.faturamentoAtribuido += l.faturamentoAtribuido; acc.temFaturamentoAtribuido = true; }
    if (l.faturamentoReal !== null && l.faturamentoReal !== undefined) { acc.faturamentoReal += l.faturamentoReal; acc.temFaturamentoReal = true; }
    if (l.margemDepoisDoAds === null || l.margemDepoisDoAds === undefined) acc.margemIncompleta = true;
    else acc.margemDepoisDoAds += l.margemDepoisDoAds;
  });

  return [...mapa.values()].map((acc) => {
    const investimento = acc.temInvestimento ? round2(acc.investimento) : null;
    const faturamentoAtribuido = acc.temFaturamentoAtribuido ? round2(acc.faturamentoAtribuido) : null;
    const faturamentoReal = acc.temFaturamentoReal ? round2(acc.faturamentoReal) : null;

    const roas = investimento && investimento > 0 && faturamentoAtribuido !== null
      ? round2(faturamentoAtribuido / investimento) : null;
    const acos = investimento !== null && faturamentoAtribuido
      ? round2((investimento / faturamentoAtribuido) * 100) : null;
    const tacos = investimento !== null && faturamentoReal
      ? round2((investimento / faturamentoReal) * 100) : null;

    const margemDepoisDoAdsPct = (!acc.margemIncompleta && faturamentoReal)
      ? round2((acc.margemDepoisDoAds / faturamentoReal) * 100) : null;
    const margemDepoisDoAds = acc.margemIncompleta ? null : round2(acc.margemDepoisDoAds);

    const classificacao = classificarDesempenho({ margemDepoisDoAdsPct, margemMinimaPct });

    return {
      campanha: acc.campanha,
      loja: acc.loja,
      contaMlId: acc.contaMlId,
      qtdAnuncios: acc.qtdAnuncios,
      investimento,
      faturamentoAtribuido,
      faturamentoReal,
      roas,
      acos,
      tacos,
      margemDepoisDoAds,
      margemDepoisDoAdsPct,
      classificacaoCodigo: classificacao.codigo,
      classificacaoLabel: classificacao.label,
      classificacaoEmoji: classificacao.emoji,
    };
  }).sort((a, b) => (b.investimento || 0) - (a.investimento || 0));
}

// Aplica a classificação em cada linha (anúncio) e monta o resumo por
// campanha em cima do resultado já classificado — as mesmas 2 chamadas que
// routes/ads.js já fazia inline (GET /api/ads) e que lib/ia/adsDecisoesCiclo.js
// (14/09/2026, agente "Ads e Performance" Fase 1) também precisa, pra nunca
// ter essa lógica duplicada em dois lugares podendo divergir.
function classificarLinhasEAgregarCampanhas(linhas, margemMinimaPct) {
  const linhasComClassificacao = (linhas || []).map((l) => {
    const classificacao = classificarDesempenho({ margemDepoisDoAdsPct: l.margemDepoisDoAdsPct, margemMinimaPct });
    return {
      ...l,
      classificacaoCodigo: classificacao.codigo,
      classificacaoLabel: classificacao.label,
      classificacaoEmoji: classificacao.emoji,
    };
  });
  const campanhas = agregarPorCampanha(linhasComClassificacao, margemMinimaPct);
  return { linhas: linhasComClassificacao, campanhas };
}

module.exports = { classificarDesempenho, agregarPorCampanha, classificarLinhasEAgregarCampanhas };
