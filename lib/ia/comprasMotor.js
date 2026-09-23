// Motor de cálculo da "Compras com IA" (Central Inteligente de Reposição de
// Estoque) — 22/09/2026, pedido explícito do usuário: substituir a aba
// Compras por uma tela que analisa cada MODELO FÍSICO (produto_base) e
// recomenda quanto comprar, sem nunca comprar sozinha (toda compra passa
// pela aprovação do usuário — ver lib/ia/comprasCiclo.js e routes/comprasIa.js).
//
// Mesma filosofia já usada em lib/ia/adsMotor.js/adsDecisor.js e
// lib/ia/adsDiagnostico.js: TODO número aqui é calculado por código
// determinístico e documentado — nada passa por uma IA generativa (essa
// entra só depois, em lib/ia/comprasDiagnostico.js, pra reescrever o texto
// já pronto em prosa mais natural, nunca pra decidir um número).
//
// Este arquivo não lê banco nem chama API nenhuma — recebe os números já
// prontos (estoque, vendas, fornecedor) e devolve o cálculo. Quem busca
// esses números é lib/ia/comprasCiclo.js, reaproveitando o que já existe:
//   • Estoque (Full e fora do Full, já convertido de kit pra unidade física
//     e a custo): lib/estoqueFisico.js#calcularEstoqueFisico — MESMA fonte
//     das telas Estoque e Estoque Full, nunca um cálculo paralelo.
//   • Vendas por período, já convertidas pra unidade física:
//     lib/relatoriosAgregados.js#relatorioProdutosPorCaixa — MESMA fonte do
//     Relatório de Produtos > Por Caixa.
const round2 = (n) => Math.round(n * 100) / 100;

// ---- Constantes do modelo (documentadas, nunca "mágicas") ----

// Quantos dias de venda projetada o usuário quer manter como colchão de
// segurança, quando o produto base não tem um valor próprio configurado.
const ESTOQUE_SEGURANCA_DIAS_PADRAO = 7;

// Até quantos dias de venda projetada à frente a IA tenta manter coberto ao
// recomendar uma compra (pedido do usuário: não recomendar comprar "só o
// mínimo", mas também não empilhar estoque parado por meses).
const HORIZONTE_COMPRA_DIAS_PADRAO = 30;

// Quantos dias ANTES do ponto de recompra a IA já sinaliza "🟠 Programar
// compra" (dá tempo do usuário se organizar, sem ainda ser urgente).
const ANTECEDENCIA_PROGRAMAR_DIAS = 7;

// Limite de variação (venda média dos últimos 7 dias vs. últimos 30) para a
// IA considerar que o modelo está "acelerando" ou "desacelerando" e dar mais
// peso aos dias mais recentes na projeção — pedido explícito do usuário:
// "Se os últimos 7 dias estiverem muito acima dos últimos 30 dias, a IA deve
// identificar aceleração e aumentar o peso dos dados recentes." A mesma
// lógica é aplicada, por simetria, para uma queda forte (desaceleração) —
// dado recente também é o mais relevante nesse caso, mesmo sem o usuário ter
// pedido isso explicitamente (documentado aqui como extensão, não um
// comportamento escondido).
const LIMIAR_ACELERACAO_PCT = 20;
const LIMIAR_DESACELERACAO_PCT = 20;

// Pesos da projeção ponderada — pedido explícito do usuário como "exemplo
// inicial" (40% / 35% / 25%). Usados sempre que NÃO há aceleração nem
// desaceleração relevante.
const PESOS_BASE = { d7: 0.40, d14: 0.35, d30: 0.25 };

// Quando há aceleração/desaceleração relevante, os dias recentes passam a
// pesar bem mais — valor conservador escolhido pra reagir rápido sem
// descartar o histórico de 30 dias por completo.
const PESOS_TENDENCIA = { d7: 0.60, d14: 0.25, d30: 0.15 };

const UM_DIA_MS = 24 * 60 * 60 * 1000;

// Projeção de venda diária, com peso maior pros dias recentes quando há uma
// aceleração ou desaceleração clara (ver constantes acima). `venda7d`/
// `venda14d`/`venda30d` são as quantidades físicas (já convertidas de
// kit/SKU pra unidade do modelo) vendidas em cada janela — nunca um total
// acumulado diferente da janela, sempre a mesma fonte
// (relatorioProdutosPorCaixa) para as três.
function calcularMediaDiariaProjetada({ venda7d, venda14d, venda30d }) {
  const v7 = Number(venda7d) || 0;
  const v14 = Number(venda14d) || 0;
  const v30 = Number(venda30d) || 0;

  const mediaDiaria7 = round2(v7 / 7);
  const mediaDiaria14 = round2(v14 / 14);
  const mediaDiaria30 = round2(v30 / 30);

  let variacaoPct = null;
  let acelerando = false;
  let desacelerando = false;
  if (mediaDiaria30 > 0) {
    variacaoPct = round2(((mediaDiaria7 - mediaDiaria30) / mediaDiaria30) * 100);
    acelerando = variacaoPct >= LIMIAR_ACELERACAO_PCT;
    desacelerando = variacaoPct <= -LIMIAR_DESACELERACAO_PCT;
  }

  const pesos = (acelerando || desacelerando) ? PESOS_TENDENCIA : PESOS_BASE;
  const mediaDiariaProjetada = round2(mediaDiaria7 * pesos.d7 + mediaDiaria14 * pesos.d14 + mediaDiaria30 * pesos.d30);

  return {
    mediaDiaria7,
    mediaDiaria14,
    mediaDiaria30,
    variacaoPct,
    acelerando,
    desacelerando,
    pesosUsados: pesos === PESOS_TENDENCIA ? 'tendencia' : 'base',
    mediaDiariaProjetada,
  };
}

// Classificação de urgência + quantidade recomendada de compra para UM
// produto base. `prazoFornecedorDias` e `estoqueSegurancaDiasConfigurado`
// podem vir `null` (fornecedor padrão não cadastrado, ou produto sem
// configuração própria de segurança) — nesse caso o cálculo usa 0 dias de
// prazo (leitura conservadora: assume que não há tempo de reação nenhum até
// o fornecedor ser cadastrado corretamente) e o padrão global de segurança,
// e devolve `prazoFornecedorIndisponivel: true` pra a tela avisar o usuário
// em vez de esconder a imprecisão.
function calcularStatusCompra({
  estoqueGalpao, estoqueFull, estoqueACaminho,
  venda7d, venda14d, venda30d,
  prazoFornecedorDias, estoqueSegurancaDiasConfigurado, custoUnitario,
  agora = new Date(),
}) {
  const galpao = Number(estoqueGalpao) || 0;
  const full = Number(estoqueFull) || 0;
  const aCaminho = Number(estoqueACaminho) || 0;
  const estoqueDisponivelReal = round2(galpao + full);
  const estoqueFuturo = round2(estoqueDisponivelReal + aCaminho);

  const projecao = calcularMediaDiariaProjetada({ venda7d, venda14d, venda30d });
  const mediaDiariaProjetada = projecao.mediaDiariaProjetada;

  const prazoFornecedorIndisponivel = prazoFornecedorDias === null || prazoFornecedorDias === undefined;
  const prazoEfetivoDias = prazoFornecedorIndisponivel ? 0 : Number(prazoFornecedorDias);
  const estoqueSegurancaDias = (estoqueSegurancaDiasConfigurado === null || estoqueSegurancaDiasConfigurado === undefined)
    ? ESTOQUE_SEGURANCA_DIAS_PADRAO
    : Number(estoqueSegurancaDiasConfigurado);

  // Sem NENHUMA venda no período todo: não há base pra projetar consumo —
  // nunca recomenda compra "no escuro" (nem quando o estoque está zerado),
  // só sinaliza que o modelo merece uma checagem manual.
  const semHistoricoDeVendas = venda7d === 0 && venda14d === 0 && venda30d === 0;
  if (semHistoricoDeVendas) {
    const status = estoqueDisponivelReal > 0 ? 'saudavel' : 'atencao';
    return {
      estoqueDisponivelReal, estoqueFuturo,
      ...projecao,
      diasCobertura: null,
      diasCoberturaFutura: null,
      dataRupturaPrevista: null,
      prazoFornecedorIndisponivel,
      estoqueSegurancaDias,
      pontoDeRecompraUnidades: null,
      estoqueDesejadoUnidades: null,
      quantidadeRecomendada: 0,
      valorEstimado: null,
      status,
      semHistoricoDeVendas: true,
    };
  }

  const diasCobertura = mediaDiariaProjetada > 0 ? round2(estoqueDisponivelReal / mediaDiariaProjetada) : null;
  const diasCoberturaFutura = mediaDiariaProjetada > 0 ? round2(estoqueFuturo / mediaDiariaProjetada) : null;

  const dataRupturaPrevista = (diasCobertura !== null)
    ? new Date(agora.getTime() + Math.max(0, diasCobertura) * UM_DIA_MS)
    : null;

  const estoqueSegurancaUnidades = round2(mediaDiariaProjetada * estoqueSegurancaDias);
  const pontoDeRecompraUnidades = round2(mediaDiariaProjetada * (prazoEfetivoDias + estoqueSegurancaDias));
  const estoqueDesejadoUnidades = round2(Math.max(mediaDiariaProjetada * HORIZONTE_COMPRA_DIAS_PADRAO, pontoDeRecompraUnidades));
  const quantidadeRecomendada = Math.max(0, Math.ceil(estoqueDesejadoUnidades - estoqueFuturo));
  const custo = (custoUnitario === null || custoUnitario === undefined) ? null : Number(custoUnitario);
  const valorEstimado = custo !== null ? round2(quantidadeRecomendada * custo) : null;

  const limiarRuptura = prazoEfetivoDias;
  const limiarComprarAgora = prazoEfetivoDias + estoqueSegurancaDias;
  const limiarProgramar = limiarComprarAgora + ANTECEDENCIA_PROGRAMAR_DIAS;
  const limiarAtencao = HORIZONTE_COMPRA_DIAS_PADRAO;

  const cobertura = diasCoberturaFutura === null ? 0 : diasCoberturaFutura;
  let status;
  if (cobertura <= limiarRuptura) status = 'ruptura';
  else if (cobertura <= limiarComprarAgora) status = 'comprar_agora';
  else if (cobertura <= limiarProgramar) status = 'programar';
  else if (cobertura <= limiarAtencao) status = 'atencao';
  else status = aCaminho > 0 ? 'a_caminho' : 'saudavel';

  return {
    estoqueDisponivelReal, estoqueFuturo,
    ...projecao,
    diasCobertura, diasCoberturaFutura, dataRupturaPrevista,
    prazoFornecedorIndisponivel, estoqueSegurancaDias, estoqueSegurancaUnidades,
    pontoDeRecompraUnidades, estoqueDesejadoUnidades,
    quantidadeRecomendada, valorEstimado, status, semHistoricoDeVendas: false,
  };
}

const STATUS_LABEL = {
  saudavel: { emoji: '🟢', label: 'Estoque saudável' },
  atencao: { emoji: '🟡', label: 'Atenção' },
  programar: { emoji: '🟠', label: 'Programar compra' },
  comprar_agora: { emoji: '🔴', label: 'Comprar agora' },
  ruptura: { emoji: '🚨', label: 'Ruptura provável' },
  a_caminho: { emoji: '🔵', label: 'Compra aprovada / a caminho' },
};

module.exports = {
  calcularMediaDiariaProjetada,
  calcularStatusCompra,
  STATUS_LABEL,
  ESTOQUE_SEGURANCA_DIAS_PADRAO,
  HORIZONTE_COMPRA_DIAS_PADRAO,
  ANTECEDENCIA_PROGRAMAR_DIAS,
  LIMIAR_ACELERACAO_PCT,
  LIMIAR_DESACELERACAO_PCT,
  PESOS_BASE,
  PESOS_TENDENCIA,
};
