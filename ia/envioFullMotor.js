// Motor de cálculo do "Agente de Envio Full" — 23/09/2026, pedido explícito
// do usuário: "agente de envio full - quando enviar ro full, quado ta
// acabando, quando segurar, quanto gastei de envios full no mes".
//
// Mesma régua de decisão já usada e aprovada em "Compras com IA"
// (lib/ia/comprasMotor.js): dias de cobertura, projeção de venda diária
// ponderada (mais peso pros dias recentes quando há aceleração/desaceleração)
// e ponto de recompra — só que aqui decide quando TRANSFERIR estoque do
// Galpão pro Full, em vez de quando comprar do fornecedor. A projeção de
// venda é a MESMA função (importada, nunca duplicada) — o jeito de prever
// quanto vai vender por dia não muda, só o que se decide fazer com esse
// número.
//
// Este arquivo não lê banco nem chama API nenhuma — recebe os números já
// prontos (estoque Galpão/Full, vendas) e devolve o cálculo. Quem busca
// esses números é lib/ia/envioFullCiclo.js, reaproveitando:
//   • Estoque físico (Full e fora do Full): lib/estoqueFisico.js —
//     MESMA fonte das telas Estoque, Estoque Full e Compras com IA.
//   • Vendas por período: lib/ia/comprasCiclo.js#buscarVendasPorJanelas —
//     MESMA fonte, nenhum cálculo paralelo.
const { calcularMediaDiariaProjetada } = require('./comprasMotor');

const round2 = (n) => Math.round(n * 100) / 100;

// ---- Constantes do modelo (documentadas, nunca "mágicas") ----

// Quantos dias de venda projetada o Full deve manter de colchão de
// segurança, quando o produto base não tem um valor próprio configurado.
// Mesmo padrão/valor-padrão de ESTOQUE_SEGURANCA_DIAS_PADRAO em
// comprasMotor.js — mantido separado aqui de propósito: são réguas
// diferentes (uma é "estoque parado no Galpão todo", a outra é "estoque
// parado no Full") e o usuário pode um dia querer valores diferentes.
const ESTOQUE_SEGURANCA_DIAS_PADRAO = 5;

// Até quantos dias de venda projetada à frente o agente tenta manter o
// Full abastecido ao recomendar um envio (não recomenda encher o Full
// "pro resto do ano" — só um horizonte razoável, mesmo espírito do
// horizonte de compra).
const HORIZONTE_ENVIO_DIAS_PADRAO = 30;

// Quantos dias ANTES do ponto de reenvio o agente já sinaliza "🟠
// Programar envio" (dá tempo do usuário se organizar, sem ainda ser
// urgente).
const ANTECEDENCIA_PROGRAMAR_DIAS = 5;

// Quantos dias uma remessa enviada ao Full costuma levar até ficar
// disponível pra venda, quando o produto base não tem um prazo próprio
// cadastrado (produtos_base.prazo_envio_full_dias) — valor conservador,
// ajustável por produto na tela.
const PRAZO_ENVIO_FULL_DIAS_PADRAO = 3;

const UM_DIA_MS = 24 * 60 * 60 * 1000;

// Classificação de urgência + quantidade recomendada de ENVIO AO FULL pra
// UM produto base. `prazoEnvioFullDiasConfigurado` e
// `estoqueSegurancaDiasConfigurado` podem vir `null` (produto sem
// configuração própria) — nesse caso usa os padrões globais acima.
//
// Diferença chave em relação a comprasMotor.js#calcularStatusCompra: aqui
// a cobertura analisada é SÓ do estoque Full (o Galpão não conta como
// "disponível pro cliente" — só como fonte de onde tirar o envio). E a
// quantidade recomendada nunca pode passar do que existe no Galpão — se o
// Galpão não tem o suficiente, o agente sinaliza `semEstoqueGalpaoSuficiente:
// true` ("segurar": a decisão certa seria enviar, mas não há de onde
// tirar) em vez de recomendar um envio que a empresa não consegue cumprir.
function calcularStatusEnvioFull({
  estoqueGalpao, estoqueFull,
  venda7d, venda14d, venda30d,
  prazoEnvioFullDiasConfigurado, estoqueSegurancaDiasConfigurado,
  agora = new Date(),
}) {
  const galpao = Number(estoqueGalpao) || 0;
  const full = Number(estoqueFull) || 0;

  const projecao = calcularMediaDiariaProjetada({ venda7d, venda14d, venda30d });
  const mediaDiariaProjetada = projecao.mediaDiariaProjetada;

  const prazoEnvioFullDias = (prazoEnvioFullDiasConfigurado === null || prazoEnvioFullDiasConfigurado === undefined)
    ? PRAZO_ENVIO_FULL_DIAS_PADRAO
    : Number(prazoEnvioFullDiasConfigurado);
  const estoqueSegurancaDias = (estoqueSegurancaDiasConfigurado === null || estoqueSegurancaDiasConfigurado === undefined)
    ? ESTOQUE_SEGURANCA_DIAS_PADRAO
    : Number(estoqueSegurancaDiasConfigurado);

  // Sem NENHUMA venda no período todo: não há base pra projetar consumo do
  // Full — nunca recomenda envio "no escuro", só sinaliza checagem manual.
  const semHistoricoDeVendas = venda7d === 0 && venda14d === 0 && venda30d === 0;
  if (semHistoricoDeVendas) {
    const status = full > 0 ? 'saudavel' : 'atencao';
    return {
      estoqueGalpao: galpao, estoqueFull: full,
      ...projecao,
      diasCoberturaFull: null,
      dataRupturaFullPrevista: null,
      prazoEnvioFullDias, estoqueSegurancaDias,
      pontoDeReenvioUnidades: null,
      estoqueDesejadoFullUnidades: null,
      quantidadeSugeridaEnvio: 0,
      semEstoqueGalpaoSuficiente: false,
      status,
      semHistoricoDeVendas: true,
    };
  }

  const diasCoberturaFull = mediaDiariaProjetada > 0 ? round2(full / mediaDiariaProjetada) : null;
  const dataRupturaFullPrevista = (diasCoberturaFull !== null)
    ? new Date(agora.getTime() + Math.max(0, diasCoberturaFull) * UM_DIA_MS)
    : null;

  const pontoDeReenvioUnidades = round2(mediaDiariaProjetada * (prazoEnvioFullDias + estoqueSegurancaDias));
  const estoqueDesejadoFullUnidades = round2(Math.max(mediaDiariaProjetada * HORIZONTE_ENVIO_DIAS_PADRAO, pontoDeReenvioUnidades));
  const necessidadeEnvio = Math.max(0, Math.ceil(estoqueDesejadoFullUnidades - full));
  const quantidadeSugeridaEnvio = Math.min(necessidadeEnvio, Math.max(0, Math.floor(galpao)));
  const semEstoqueGalpaoSuficiente = necessidadeEnvio > 0 && quantidadeSugeridaEnvio < necessidadeEnvio;

  const limiarRuptura = prazoEnvioFullDias;
  const limiarEnviarAgora = prazoEnvioFullDias + estoqueSegurancaDias;
  const limiarProgramar = limiarEnviarAgora + ANTECEDENCIA_PROGRAMAR_DIAS;
  const limiarAtencao = HORIZONTE_ENVIO_DIAS_PADRAO;

  const cobertura = diasCoberturaFull === null ? 0 : diasCoberturaFull;
  let status;
  if (cobertura <= limiarRuptura) status = 'ruptura';
  else if (cobertura <= limiarEnviarAgora) status = 'enviar_agora';
  else if (cobertura <= limiarProgramar) status = 'programar_envio';
  else if (cobertura <= limiarAtencao) status = 'atencao';
  else status = 'saudavel';

  return {
    estoqueGalpao: galpao, estoqueFull: full,
    ...projecao,
    diasCoberturaFull, dataRupturaFullPrevista,
    prazoEnvioFullDias, estoqueSegurancaDias,
    pontoDeReenvioUnidades, estoqueDesejadoFullUnidades,
    quantidadeSugeridaEnvio, semEstoqueGalpaoSuficiente,
    status, semHistoricoDeVendas: false,
  };
}

const STATUS_LABEL = {
  saudavel: { emoji: '🟢', label: 'Full abastecido — segurar envio' },
  atencao: { emoji: '🟡', label: 'Atenção' },
  programar_envio: { emoji: '🟠', label: 'Programar envio' },
  enviar_agora: { emoji: '🔴', label: 'Enviar agora' },
  ruptura: { emoji: '🚨', label: 'Full acabando — enviar urgente' },
};

module.exports = {
  calcularStatusEnvioFull,
  STATUS_LABEL,
  ESTOQUE_SEGURANCA_DIAS_PADRAO,
  HORIZONTE_ENVIO_DIAS_PADRAO,
  ANTECEDENCIA_PROGRAMAR_DIAS,
  PRAZO_ENVIO_FULL_DIAS_PADRAO,
};
