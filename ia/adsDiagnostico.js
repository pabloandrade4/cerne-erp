// Diagnóstico completo por anúncio — Agente IA "Ads e Performance",
// 21/09/2026, pedido explícito do usuário: "quero que a IA me dê relatórios
// como esse que vou te enviar, diagnosticando 100% daquele anúncio de ads e
// não só pedindo pra pausar" (o usuário colou um relatório real que ele
// mesmo tinha escrito à mão, analisando impressões/cliques/CTR/conversão/
// CPA/ACOS/ROAS/vendas orgânicas de um anúncio patrocinado e propondo um
// teste de monitoramento de alguns dias sem Ads).
//
// Confirmado com o usuário antes de construir (AskUserQuestion):
//   1) o relatório é por ANÚNCIO (não por campanha inteira);
//   2) é gerado AUTOMATICAMENTE pelo ciclo em segundo plano (ver
//      lib/ia/adsDecisoesCiclo.js), sempre que o anúncio for classificado
//      como candidato a pausar Ads (mesma situação que já gera a sugestão
//      "pausar_anuncio" em lib/ia/adsDecisor.js).
//
// DESENHO (por que o relatório NUNCA depende só da IA generativa): TODA a
// tabela de métricas, cada "leitura" (interpretação) por métrica, a ação
// recomendada e as faixas do teste de monitoramento são calculadas aqui
// embaixo por REGRA DETERMINÍSTICA — os mesmos números reais que a tela de
// Ads já usa (lib/ads.js), nunca um valor novo. A IA generativa (mesmo
// provedor da IA Gestora/SAC, ver lib/ia/providers) é usada só para
// REESCREVER esse relatório determinístico em prosa mais natural — nunca
// para decidir um número ou uma ação diferente da que a regra já decidiu.
// Se a IA generativa não estiver configurada, falhar ou devolver algo vazio,
// o relatório determinístico (montarRelatorioTextoBase) já é completo e
// legível sozinho — o recurso NUNCA fica bloqueado por falta de IA.
const { obterProvedorConfigurado } = require('./providers');

const DIAS_PERIODO_PADRAO = 30; // mesma janela usada pelo ciclo de decisões (lib/ia/adsDecisoesCiclo.js)
const DIAS_TESTE_PAUSA = 7;

// Limites pra classificar CTR/conversão como "fraco"/"mediano"/"bom" — só
// linguagem (nunca mudam um número), documentados aqui pra serem fáceis de
// ajustar/explicar, mesmo espírito das constantes de lib/ia/adsDecisor.js.
const CTR_BOM_PCT = 1;
const CTR_FRACO_PCT = 0.4;
const CONVERSAO_BOA_PCT = 3;
const CONVERSAO_FRACA_PCT = 1;
const RAZAO_OUTRAS_VENDAS_FORTE = 5; // outras vendas >= 5x as vendas via Ads -> "vende bem sozinho"
const GASTO_VS_ORCAMENTO_BAIXO_PCT = 50; // gasto médio diário < 50% do orçamento configurado

// Faixas do teste de monitoramento (comparar venda orgânica média/dia,
// ANTES de pausar, com a venda REAL observada durante os dias do teste) —
// ±15% do baseline = "não mudou nada" (Ads não parecia ajudar); abaixo de
// 55% do baseline = "caiu forte" (Ads provavelmente ajudava mais do que
// parecia). Percentuais documentados, fáceis de revisar — nunca "no olho".
const FAIXA_ALTA_TOLERANCIA_PCT = 15;
const FAIXA_MEDIA_LIMITE_INFERIOR_PCT = 55;

function round2(n) { return Math.round(n * 100) / 100; }
function numOuNull(v) { return v === null || v === undefined ? null : Number(v); }

function pctDe(numerador, denominador) {
  if (numerador === null || numerador === undefined) return null;
  if (!denominador) return null;
  return round2((numerador / denominador) * 100);
}

function moeda(v) {
  if (v === null || v === undefined) return 'dado indisponível';
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(v) {
  if (v === null || v === undefined) return 'dado indisponível';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}
function inteiro(v) {
  if (v === null || v === undefined) return 'dado indisponível';
  return Number(v).toLocaleString('pt-BR');
}
function roasTxt(v) {
  if (v === null || v === undefined) return 'dado indisponível';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'x';
}

// ---- Interpretações determinísticas por métrica (coluna "Leitura") ----
function leituraCtr(ctr) {
  if (ctr === null) return null;
  if (ctr >= CTR_BOM_PCT) return 'Boa taxa de clique';
  if (ctr < CTR_FRACO_PCT) return 'Muito fraco para o tanto de exposição';
  return 'Mediano';
}
function leituraConversao(conv) {
  if (conv === null) return null;
  if (conv >= CONVERSAO_BOA_PCT) return 'Boa conversão';
  if (conv < CONVERSAO_FRACA_PCT) return 'Muito baixa';
  return 'Mediana';
}
function leituraAcos(acos, acosAlvo) {
  if (acos === null) return null;
  if (acosAlvo !== null && acosAlvo !== undefined) {
    return acos <= acosAlvo ? 'Dentro da meta configurada' : 'Acima da meta configurada';
  }
  return null;
}
function leituraOutrasVendas(outrasVendas, vendasAds) {
  if (outrasVendas === null) return null;
  if (!vendasAds) {
    return outrasVendas > 0 ? 'O produto vende sozinho — nenhuma venda foi atribuída ao Ads no período' : null;
  }
  if (outrasVendas >= vendasAds * RAZAO_OUTRAS_VENDAS_FORTE) {
    return 'O produto vende fortemente sem atribuição ao Ads';
  }
  return null;
}

// ---- Todos os números reais + interpretações, em um único objeto — nunca
// nenhum campo novo além do que já existe em `linha` (lib/ads.js) e
// `metaCampanha` (ads_campanhas, já lido por lib/ia/adsDecisoesCiclo.js). ----
function montarDadosDiagnostico({ linha, metaCampanha, diasPeriodo = DIAS_PERIODO_PADRAO }) {
  const impressoes = numOuNull(linha.impressoes);
  const cliques = numOuNull(linha.cliques);
  const ctr = pctDe(cliques, impressoes);
  const cpc = numOuNull(linha.cpc);
  const investimento = numOuNull(linha.investimento);
  const vendasAds = numOuNull(linha.qtdVendasAtribuidas);
  const conversaoAds = (cliques && vendasAds !== null) ? pctDe(vendasAds, cliques) : null;
  const receitaAds = numOuNull(linha.faturamentoAtribuido);
  const cpa = (vendasAds && investimento !== null) ? round2(investimento / vendasAds) : null;
  const acos = numOuNull(linha.acos);
  const roas = numOuNull(linha.roas);
  const quantidadeVendidaReal = numOuNull(linha.quantidadeVendidaReal) || 0;
  const outrasVendas = vendasAds !== null ? Math.max(0, round2(quantidadeVendidaReal - vendasAds)) : null;

  const orcamentoDiario = metaCampanha ? numOuNull(metaCampanha.orcamentoDiario) : null;
  const acosAlvo = metaCampanha ? numOuNull(metaCampanha.acosAlvo) : null;
  const acosBenchmark = metaCampanha ? numOuNull(metaCampanha.acosBenchmark) : null;
  const gastoMedioDiario = investimento !== null ? round2(investimento / diasPeriodo) : null;
  const gastoMuitoAbaixoDoOrcamento = (orcamentoDiario && gastoMedioDiario !== null)
    ? pctDe(gastoMedioDiario, orcamentoDiario) < GASTO_VS_ORCAMENTO_BAIXO_PCT
    : false;

  const baselineVendasDia = outrasVendas !== null ? round2(outrasVendas / diasPeriodo) : null;
  let teste = null;
  if (baselineVendasDia !== null) {
    const baselineTeste = round2(baselineVendasDia * DIAS_TESTE_PAUSA);
    const limiteAlto = round2(baselineTeste * (1 - FAIXA_ALTA_TOLERANCIA_PCT / 100));
    const limiteMedio = round2(baselineTeste * (FAIXA_MEDIA_LIMITE_INFERIOR_PCT / 100));
    teste = {
      dias: DIAS_TESTE_PAUSA,
      baselineVendasDia,
      baselineNoPeriodoDeTeste: baselineTeste,
      faixas: [
        { de: limiteAlto, ate: null, label: 'Perto do normal', interpretacao: 'Ads não parecia estar ajudando — melhor não voltar por enquanto.' },
        { de: limiteMedio, ate: limiteAlto, label: 'Caiu um pouco', interpretacao: 'Antes de reativar, vale olhar preço, concorrência e conversão.' },
        { de: 0, ate: limiteMedio, label: 'Caiu forte', interpretacao: 'Ads provavelmente ajudava mais do que parecia — reativar com outra estratégia.' },
      ],
    };
  }

  const metricas = [
    { label: 'Impressões', valor: inteiro(impressoes), leitura: null },
    { label: 'Cliques', valor: inteiro(cliques), leitura: null },
    { label: 'CTR', valor: pct(ctr), leitura: leituraCtr(ctr) },
    { label: 'CPC', valor: moeda(cpc), leitura: null },
    { label: 'Investimento', valor: moeda(investimento), leitura: null },
    { label: 'Vendas via Ads', valor: inteiro(vendasAds), leitura: null },
    { label: 'Conversão (Ads)', valor: pct(conversaoAds), leitura: leituraConversao(conversaoAds) },
    { label: 'Receita atribuída ao Ads', valor: moeda(receitaAds), leitura: null },
    { label: 'CPA (custo por venda via Ads)', valor: moeda(cpa), leitura: null },
    { label: 'ACOS', valor: pct(acos), leitura: leituraAcos(acos, acosAlvo) },
    { label: 'ROAS real', valor: roasTxt(roas), leitura: null },
    { label: 'Outras vendas (sem atribuição ao Ads)', valor: inteiro(outrasVendas), leitura: leituraOutrasVendas(outrasVendas, vendasAds) },
  ];

  return {
    anuncio: linha.anuncio || null, sku: linha.sku || null, loja: linha.loja || null, campanha: linha.campanha || null,
    diasPeriodo, metricas,
    orcamento: { orcamentoDiario, gastoMedioDiario, acosAlvo, acosBenchmark, gastoMuitoAbaixoDoOrcamento },
    gargalos: {
      ctrFraco: ctr !== null && ctr < CTR_FRACO_PCT,
      conversaoFraca: conversaoAds !== null && conversaoAds < CONVERSAO_FRACA_PCT,
    },
    teste,
  };
}

// ---- Relatório em texto, 100% determinístico — é o que o usuário vê quando
// a IA generativa não está disponível, e também a "base" que pedimos pra IA
// reescrever com mais fluência (nunca mudando um número). ----
function montarRelatorioTextoBase(dados) {
  const linhas = [];
  const refAnuncio = dados.anuncio ? `"${dados.anuncio}"` : 'este anúncio';
  linhas.push(`Diagnóstico de ${refAnuncio}${dados.sku ? ` (SKU ${dados.sku})` : ''}${dados.loja ? `, loja ${dados.loja}` : ''}${dados.campanha ? `, campanha "${dados.campanha}"` : ''} — últimos ${dados.diasPeriodo} dias.`);
  linhas.push('');
  linhas.push('| Métrica | Resultado | Leitura |');
  linhas.push('|---|---|---|');
  dados.metricas.forEach((m) => {
    linhas.push(`| ${m.label} | ${m.valor} | ${m.leitura || '—'} |`);
  });
  linhas.push('');

  if (dados.orcamento.gastoMuitoAbaixoDoOrcamento) {
    linhas.push(`Orçamento diário configurado: ${moeda(dados.orcamento.orcamentoDiario)}. Gasto médio diário real no período: ${moeda(dados.orcamento.gastoMedioDiario)} — bem abaixo do orçamento disponível, então o problema deste anúncio não parece ser orçamento.`);
    linhas.push('');
  }

  if (dados.gargalos.ctrFraco && dados.gargalos.conversaoFraca) {
    linhas.push('Dois gargalos diferentes: impressão → clique está fraco (CTR baixo) e clique → compra também está fraco (conversão baixa). Mexer só no orçamento não resolve nenhum dos dois — o anúncio/oferta (preço, foto de capa, título) precisa ser revisado antes de escalar.');
    linhas.push('');
  } else if (dados.gargalos.ctrFraco) {
    linhas.push('O gargalo principal está entre impressão e clique (CTR baixo) — vale revisar foto de capa, título e preço frente à concorrência.');
    linhas.push('');
  } else if (dados.gargalos.conversaoFraca) {
    linhas.push('O gargalo principal está entre clique e compra (conversão baixa) — quem clica não está comprando; vale revisar preço, ficha do anúncio e avaliações.');
    linhas.push('');
  }

  if (dados.teste) {
    linhas.push(`Teste sugerido: pausar o patrocínio (Product Ads) deste anúncio por ${dados.teste.dias} dias, sem pausar o anúncio no Mercado Livre, e acompanhar a venda orgânica. Base atual: ${dados.teste.baselineVendasDia} venda(s)/dia sem Ads, ou aproximadamente ${dados.teste.baselineNoPeriodoDeTeste} em ${dados.teste.dias} dias.`);
    dados.teste.faixas.forEach((f) => {
      const faixaTxt = f.ate === null ? `${f.de}+` : `${f.de} a ${f.ate}`;
      linhas.push(`- ${faixaTxt} vendas em ${dados.teste.dias} dias (${f.label}): ${f.interpretacao}`);
    });
  }

  return linhas.join('\n');
}

function montarSystemPromptReescrita() {
  return [
    'Você reescreve um relatório de diagnóstico de anúncio patrocinado (Product Ads do Mercado Livre) em português do Brasil, em prosa natural e direta — no tom de um analista de e-commerce experiente explicando a decisão para o dono de uma loja não-técnico.',
    '',
    'REGRAS QUE VOCÊ NUNCA PODE QUEBRAR:',
    '1. O relatório que você vai receber já tem TODOS os números corretos (tabela de métricas, orçamento, faixas do teste). Você NUNCA muda, arredonda diferente, soma ou recalcula nenhum número — copie exatamente como está.',
    '2. Você NUNCA sugere uma ação diferente da que já está no relatório (por exemplo, nunca sugere aumentar/diminuir orçamento se o relatório não falou nisso, nunca sugere mudar a meta de ACOS).',
    '3. Você pode reorganizar, comentar e explicar melhor os números, com a mesma lógica de um analista (compare CTR com cliques, compare vendas via Ads com outras vendas, etc.) — mas sempre a partir dos números que já foram dados, nunca inventando um novo.',
    '4. Mantenha a tabela de métricas (Métrica / Resultado / Leitura) em formato de tabela Markdown, exatamente com os mesmos valores recebidos.',
    '5. Se algum dado vier como "dado indisponível", mantenha essa frase — nunca invente um valor no lugar.',
    '6. Responda só com o relatório final, sem introdução nem comentário fora dele.',
  ].join('\n');
}

function extrairTextoDosBlocos(conteudo) {
  return (conteudo || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Gera o relatório completo de um anúncio: sempre devolve, no mínimo, o
// relatório determinístico (`textoBase`) — a reescrita pela IA generativa
// (`textoIa`) é um extra, null quando o provedor não está configurado, a
// chamada falha, ou devolve algo vazio. Nunca lança — quem chama sempre
// recebe algo pra mostrar/gravar.
async function gerarDiagnosticoAnuncio({ linha, metaCampanha, diasPeriodo }) {
  const dados = montarDadosDiagnostico({ linha, metaCampanha, diasPeriodo });
  const textoBase = montarRelatorioTextoBase(dados);

  const provedor = obterProvedorConfigurado();
  if (provedor.erro) {
    return { dados, textoBase, textoIa: null, motivoSemIa: provedor.erro };
  }

  try {
    const resposta = await provedor.enviarMensagem({
      system: montarSystemPromptReescrita(),
      mensagens: [{ role: 'user', content: textoBase }],
      ferramentas: undefined,
      maxTokens: 1400,
    });
    const texto = extrairTextoDosBlocos(resposta.conteudo);
    if (!texto) return { dados, textoBase, textoIa: null, motivoSemIa: 'O provedor de IA devolveu uma resposta vazia.' };
    return { dados, textoBase, textoIa: texto, motivoSemIa: null };
  } catch (err) {
    console.error(`[Ads IA][diagnóstico] falha ao reescrever relatório do anúncio ${linha.mlItemId || linha.sku || ''}: ${err.message}`);
    return { dados, textoBase, textoIa: null, motivoSemIa: err.message || 'Erro desconhecido ao chamar o provedor de IA.' };
  }
}

module.exports = {
  montarDadosDiagnostico,
  montarRelatorioTextoBase,
  gerarDiagnosticoAnuncio,
  DIAS_PERIODO_PADRAO,
  DIAS_TESTE_PAUSA,
  CTR_BOM_PCT,
  CTR_FRACO_PCT,
  CONVERSAO_BOA_PCT,
  CONVERSAO_FRACA_PCT,
  FAIXA_ALTA_TOLERANCIA_PCT,
  FAIXA_MEDIA_LIMITE_INFERIOR_PCT,
};
