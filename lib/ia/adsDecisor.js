// Agente de IA "Ads e Performance" — Fase 1 (14/09/2026), pedido explícito
// do usuário: a IA não deve só classificar (PAUSAR/AJUSTAR/MANTER/ESCALAR,
// ver lib/ia/adsMotor.js) — deve recomendar uma AÇÃO concreta e explicável,
// que o usuário aprova, altera ou recusa (ver lib/ia/adsDecisoesCiclo.js,
// que grava cada sugestão em ia_decisoes_ads). Regras determinísticas e
// simples de propósito nesta primeira versão (percentuais fixos, iguais
// pra qualquer empresa) — a Fase 2 (ainda NÃO implementada) é que vai
// ajustar esses percentuais com base no histórico real de decisões de cada
// usuário ("com base em X decisões semelhantes, você preferiu Y"), nunca
// uma "caixa preta".
//
// Este arquivo NUNCA chama a API do Mercado Livre e NUNCA decide um valor
// sem citar o número real que originou o cálculo — mesma filosofia de
// lib/promocoesMotor.js e lib/ia/adsMotor.js.

const round2 = (n) => Math.round(n * 100) / 100;

const AJUSTE_REDUCAO_ORCAMENTO_PCT = 20; // classificação "ajustar" -> reduz orçamento em 20%
const AJUSTE_AUMENTO_ORCAMENTO_PCT = 20; // classificação "escalar" -> aumenta orçamento em 20%
const ORCAMENTO_MINIMO_SUGERIDO = 5;     // nunca sugere reduzir orçamento pra menos que isso (R$)
const VENDAS_MINIMAS_PARA_SUGERIR_CAMPANHA = 5; // vendas orgânicas mínimas no período pra considerar um SKU "candidato a Ads"

// ---- Sugestão por ANÚNCIO individual dentro de uma campanha ----
// Só sugere ação quando a classificação por anúncio (lib/ia/adsMotor.js)
// já indica PAUSAR — é o caso mais seguro e objetivo: o resultado real
// após Ads é negativo. Orçamento/meta de ACOS são atributos da CAMPANHA,
// não do anúncio — ver sugerirAcaoCampanha abaixo.
function sugerirAcaoAnuncio({ linha }) {
  if (!linha || linha.classificacaoCodigo !== 'pausar') return null;
  if (!linha.campanha) return null; // sem campanha, "pausar anúncio" em Ads não se aplica
  const margemTxt = linha.margemDepoisDoAds !== null && linha.margemDepoisDoAds !== undefined
    ? 'R$ ' + Number(linha.margemDepoisDoAds).toFixed(2)
    : 'indisponível';
  return {
    tipoAcao: 'pausar_anuncio',
    motivo: `Resultado após Ads negativo (${margemTxt}) — este anúncio está gastando em Ads sem gerar lucro.`,
    valorSugeridoIa: { acao: 'pausar' },
  };
}

// Anúncio SEM campanha (venda 100% orgânica) com margem real positiva e
// volume de vendas — candidato a entrar em uma campanha de Ads (pedido
// explícito do usuário: "colocar um SKU em campanha"). Não indica QUAL
// campanha (o ERP não tem como saber isso sozinho) — é uma sugestão pra
// avaliação do usuário, não uma ação automática.
function sugerirEntrarEmCampanha({ linha }) {
  if (!linha || linha.campanha) return null;
  if (linha.semVendaReal) return null;
  if (linha.margemAntesDoAds === null || linha.margemAntesDoAds === undefined || linha.margemAntesDoAds <= 0) return null;
  if (!linha.quantidadeVendidaReal || linha.quantidadeVendidaReal < VENDAS_MINIMAS_PARA_SUGERIR_CAMPANHA) return null;
  return {
    tipoAcao: 'colocar_sku_em_campanha',
    motivo: `SKU com ${linha.quantidadeVendidaReal} venda(s) orgânica(s) no período e margem real positiva (R$ ${Number(linha.margemAntesDoAds).toFixed(2)}) — pode ser um bom candidato a entrar em uma campanha de Ads.`,
    valorSugeridoIa: { acao: 'considerar_incluir_em_campanha' },
  };
}

// ---- Sugestão por CAMPANHA (orçamento, meta de ACOS, status) ----
// `orcamentoAtual`/`statusCampanhaAtual` vêm do que já foi sincronizado em
// ads_campanhas (dado real da API, nunca inventado) — sem esse dado, não
// dá pra sugerir um valor concreto de orçamento (fica sem sugestão nesta
// fase, em vez de adivinhar).
function sugerirAcaoCampanha({ campanha, orcamentoAtual, statusCampanhaAtual }) {
  if (!campanha) return null;
  const codigo = campanha.classificacaoCodigo;
  const margemPctTxt = campanha.margemDepoisDoAdsPct !== null && campanha.margemDepoisDoAdsPct !== undefined
    ? Number(campanha.margemDepoisDoAdsPct).toFixed(1) + '%'
    : 'indisponível';

  if (codigo === 'pausar') {
    if (statusCampanhaAtual === 'paused') return null; // já pausada — nada a sugerir
    const margemTxt = campanha.margemDepoisDoAds !== null && campanha.margemDepoisDoAds !== undefined
      ? 'R$ ' + Number(campanha.margemDepoisDoAds).toFixed(2) : 'indisponível';
    return {
      tipoAcao: 'pausar_campanha',
      motivo: `Resultado após Ads negativo somando todos os anúncios da campanha (${margemTxt}).`,
      valorSugeridoIa: { acao: 'pausar' },
    };
  }

  if (codigo === 'ajustar') {
    if (orcamentoAtual === null || orcamentoAtual === undefined) return null;
    const orcamentoSugerido = Math.max(ORCAMENTO_MINIMO_SUGERIDO, round2(orcamentoAtual * (1 - AJUSTE_REDUCAO_ORCAMENTO_PCT / 100)));
    if (orcamentoSugerido >= orcamentoAtual) return null;
    return {
      tipoAcao: 'diminuir_orcamento',
      motivo: `Margem após Ads positiva mas abaixo do mínimo configurado (${margemPctTxt}) — reduzir o orçamento em ${AJUSTE_REDUCAO_ORCAMENTO_PCT}% é uma primeira tentativa de melhorar o resultado sem pausar a campanha.`,
      valorSugeridoIa: { acao: 'diminuir_orcamento', orcamentoAtual, orcamentoSugerido },
    };
  }

  if (codigo === 'escalar') {
    if (statusCampanhaAtual === 'paused') {
      return {
        tipoAcao: 'ativar_campanha',
        motivo: `Margem após Ads bem acima do mínimo configurado (${margemPctTxt}), mas a campanha está pausada no Mercado Livre.`,
        valorSugeridoIa: { acao: 'ativar' },
      };
    }
    if (orcamentoAtual === null || orcamentoAtual === undefined) return null;
    const orcamentoSugerido = round2(orcamentoAtual * (1 + AJUSTE_AUMENTO_ORCAMENTO_PCT / 100));
    return {
      tipoAcao: 'aumentar_orcamento',
      motivo: `Margem após Ads folgada (${margemPctTxt}, ≥1,5x o mínimo configurado) — aumentar o orçamento em ${AJUSTE_AUMENTO_ORCAMENTO_PCT}% é uma forma de escalar esta campanha mantendo a mesma lógica de resultado.`,
      valorSugeridoIa: { acao: 'aumentar_orcamento', orcamentoAtual, orcamentoSugerido },
    };
  }

  return null; // manter / dados_insuficientes: sem ação
}

module.exports = {
  sugerirAcaoAnuncio,
  sugerirEntrarEmCampanha,
  sugerirAcaoCampanha,
  AJUSTE_REDUCAO_ORCAMENTO_PCT,
  AJUSTE_AUMENTO_ORCAMENTO_PCT,
  ORCAMENTO_MINIMO_SUGERIDO,
  VENDAS_MINIMAS_PARA_SUGERIR_CAMPANHA,
};
