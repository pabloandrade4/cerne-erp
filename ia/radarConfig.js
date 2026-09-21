// Radar da IA — limiares (thresholds) usados pelas regras determinísticas
// de lib/ia/radarAnuncios.js e lib/ia/radarNegocio.js.
//
// Mesma filosofia já usada em lib/visaoGeralPainel.js#ESTOQUE_BAIXO_LIMITE
// (comentário original: "um limiar simples e declarado — não é previsão de
// demanda"): estes números NÃO são um modelo preditivo/machine learning —
// são pontos de corte simples e documentados, pra decidir quando uma
// situação já calculada com dado real (vendas, margem, estoque, Ads,
// financeiro) merece virar um alerta. Podem virar configuráveis por
// empresa numa etapa futura; por enquanto são globais, documentados aqui
// num lugar só.
module.exports = {
  // ---------------- Por anúncio/SKU (lib/ia/radarAnuncios.js) ----------------

  // "Vendendo pouco": poucas unidades vendidas numa janela de 30 dias.
  ANUNCIO_VENDA_BAIXA_QTD_30D: 5,
  // "Dias sem nenhuma venda" que já preocupa vs. que já é "praticamente parado".
  ANUNCIO_DIAS_SEM_VENDA_ATENCAO: 10,
  ANUNCIO_DIAS_SEM_VENDA_PARADO: 30,
  // "Muito faturamento e pouco resultado": faturamento mínimo (30d) pra a
  // margem baixa importar (um SKU de R$50/mês com margem de 3% não merece
  // alerta — o valor em jogo é pequeno demais).
  ANUNCIO_FATURAMENTO_RELEVANTE_30D: 1000,
  ANUNCIO_MARGEM_BAIXA_PCT: 5,
  // Oportunidades: margem considerada saudável, e crescimento mínimo
  // (comparando os últimos 7 dias com os 7 dias imediatamente anteriores)
  // pra contar como "cresceu de verdade" (não ruído de dia a dia).
  ANUNCIO_MARGEM_SAUDAVEL_PCT: 15,
  ANUNCIO_CRESCIMENTO_PCT_7D: 30,
  // Faturamento mínimo (30d) pra um "bom desempenho" ser destacado como
  // oportunidade (evita destacar um SKU de R$20/mês só porque a margem % é boa).
  ANUNCIO_BOM_DESEMPENHO_FATURAMENTO_30D: 300,

  // ---------------- Estoque (lib/ia/radarNegocio.js) ----------------

  // Cobertura estimada (dias) = estoque atual ÷ velocidade média de venda
  // recente. Abaixo disso, entra como "precisa de atenção"/"crítico".
  ESTOQUE_COBERTURA_CRITICA_DIAS: 7,
  ESTOQUE_COBERTURA_BAIXA_DIAS: 14,
  // "Excesso de estoque": cobertura estimada muito alta (dinheiro parado
  // além do razoável) — só alertado quando há venda real o suficiente pra
  // a estimativa ter algum sentido (ver radarNegocio.js).
  ESTOQUE_COBERTURA_EXCESSO_DIAS: 120,

  // ---------------- Fluxo de caixa (lib/ia/radarNegocio.js) ----------------

  // O ERP não tem saldo bancário cadastrado (regra permanente do projeto —
  // ver docs/01-regras-de-negocio.md) — o "risco de caixa" aqui NUNCA
  // inventa um saldo: compara só valores previstos reais (contas a pagar
  // vencendo em breve vs. contas a receber + recebimentos do Mercado Livre
  // esperados no mesmo prazo). Quando pagar > receber por uma margem
  // relevante nos próximos N dias, é um risco real de aperto de caixa.
  FLUXO_CAIXA_JANELA_DIAS: 7,
  // Múltiplo mínimo (pagar ÷ receber) nos próximos N dias pra considerar
  // "risco" (1.0 = empatado). 1.2 = pagamentos previstos superam em pelo
  // menos 20% os recebimentos previstos no mesmo prazo.
  FLUXO_CAIXA_RISCO_MULTIPLO: 1.2,

  // ---------------- Compras (lib/ia/radarNegocio.js) ----------------

  // Reaproveita os mesmos limiares de estoque acima pra decidir "precisa
  // comprar" — sem duplicar o número aqui, ver radarNegocio.js.
};
