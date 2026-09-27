// Projeção de vendas do mês corrente (Visão Geral) — 26/09/2026, pedido
// explícito do usuário: "projeção de vendas dentro daquele mes" (a resposta
// que ele escolheu, em vez das opções de janela corrida de 7/30 dias que
// foram oferecidas primeiro — ver AskUserQuestion desta etapa).
//
// O que este arquivo calcula: quanto a empresa deve faturar no MÊS
// CALENDÁRIO atual (ex.: setembro inteiro), somando o que já vendeu de
// verdade até agora + uma projeção do que falta vender nos dias restantes,
// baseada na tendência recente (média diária dos últimos 7/14/30 dias).
//
// NUNCA duplica cálculo já existente:
//   - a tendência (média diária ponderada, com detecção de
//     aceleração/desaceleração) reaproveita EXATAMENTE
//     calcularMediaDiariaProjetada de lib/ia/comprasMotor.js — a mesma conta
//     já usada pro Agente de Compras, só que aplicada ao faturamento total
//     da empresa em vez de vendas de 1 produto (a fórmula é genérica).
//   - o faturamento realizado e as somas por janela de dias vêm de
//     buscarPedidosDoPeriodo/resumirPeriodo de lib/relatorioVendas.js — a
//     MESMA fonte única usada por Visão Geral/Pedidos/Financeiro/Relatórios.
//
// Isto é uma ESTIMATIVA, nunca um valor garantido — por isso toda resposta
// carrega `mediaDiariaProjetada`/`variacaoPct`/`diasRestantes` junto, pra
// tela poder deixar claro que é projeção, não fato.
const { calcularMediaDiariaProjetada } = require('./comprasMotor');
const { buscarPedidosDoPeriodo, resumirPeriodo } = require('../relatorioVendas');
const { inicioDoMesBRT } = require('../periodo');

const UM_DIA_MS = 24 * 60 * 60 * 1000;

function round2(v) {
  return v === null || v === undefined ? null : Math.round(v * 100) / 100;
}

// Cálculo puro (testável sem banco): dado o que já foi faturado no mês até
// agora e a tendência diária recente, projeta o total do mês.
function calcularProjecaoMes({ faturamentoRealizado, diasDecorridos, diasRestantes, mediaDiariaProjetada }) {
  const realizado = round2(faturamentoRealizado) || 0;
  const media = mediaDiariaProjetada || 0;
  const projecaoRestante = diasRestantes > 0 ? round2(media * diasRestantes) : 0;
  const projecaoTotalMes = round2(realizado + projecaoRestante);
  return {
    faturamentoRealizado: realizado,
    diasDecorridos,
    diasRestantes,
    mediaDiariaProjetada: media,
    projecaoRestante,
    projecaoTotalMes,
  };
}

// Início do mês SEGUINTE (BRT) — usado só pra saber quantos dias tem o mês
// corrente (fim = início do próximo mês, exclusivo), sem reimplementar
// aritmética de calendário (mês com 28/29/30/31 dias) na mão.
function inicioDoProximoMesBRT(inicioMesAtual) {
  // Soma dias suficientes pra garantir que caiu no mês seguinte (no máximo
  // 31 dias à frente), depois normaliza pro dia 1 desse mês em BRT — evita
  // reimplementar "quantos dias tem este mês" com uma tabela de meses.
  const candidato = new Date(inicioMesAtual.getTime() + 31 * UM_DIA_MS);
  return inicioDoMesBRT(candidato);
}

// Orquestração (precisa de Postgres): busca os pedidos reais do mês e das
// janelas de tendência (7/14/30 dias corridos terminando agora), e devolve
// a projeção completa pronta pra Visão Geral.
async function projetarVendasDoMes({ empresaId, agora = new Date() }) {
  const inicioMes = inicioDoMesBRT(agora);
  const inicioProximoMes = inicioDoProximoMesBRT(inicioMes);
  const diasNoMes = Math.round((inicioProximoMes.getTime() - inicioMes.getTime()) / UM_DIA_MS);
  const diasDecorridos = Math.min(diasNoMes, Math.max(1, Math.ceil((agora.getTime() - inicioMes.getTime()) / UM_DIA_MS)));
  const diasRestantes = Math.max(0, diasNoMes - diasDecorridos);

  // Faturamento já realizado no mês corrente, até agora — mesma fonte única
  // de sempre (buscarPedidosDoPeriodo + resumirPeriodo), já excluindo
  // cancelados E devolvidos (ver lib/relatorioVendas.js).
  const { pedidos: pedidosDoMes } = await buscarPedidosDoPeriodo({ empresaId, desde: inicioMes, ate: agora });
  const faturamentoRealizado = resumirPeriodo(pedidosDoMes).faturamento.valor || 0;

  // Janela de 30 dias corridos terminando agora, buscada UMA VEZ só — as
  // somas de 7/14/30 dias usadas pela tendência são recortadas dela em
  // memória (nunca 3 consultas separadas ao banco pra mesma informação).
  const desde30d = new Date(agora.getTime() - 30 * UM_DIA_MS);
  const desde14d = new Date(agora.getTime() - 14 * UM_DIA_MS);
  const desde7d = new Date(agora.getTime() - 7 * UM_DIA_MS);
  const { pedidos: pedidosUltimos30d } = await buscarPedidosDoPeriodo({ empresaId, desde: desde30d, ate: agora });

  const somaDesde = (desdeData) => {
    const filtrados = pedidosUltimos30d.filter((p) => p.dataEfetiva && new Date(p.dataEfetiva) >= desdeData);
    return resumirPeriodo(filtrados).faturamento.valor || 0;
  };
  const venda7d = somaDesde(desde7d);
  const venda14d = somaDesde(desde14d);
  const venda30d = somaDesde(desde30d);

  const tendencia = calcularMediaDiariaProjetada({ venda7d, venda14d, venda30d });

  const projecao = calcularProjecaoMes({
    faturamentoRealizado,
    diasDecorridos,
    diasRestantes,
    mediaDiariaProjetada: tendencia.mediaDiariaProjetada,
  });

  return {
    ...projecao,
    tendencia,
    diasNoMes,
    inicioMes: inicioMes.toISOString(),
  };
}

module.exports = {
  calcularProjecaoMes,
  projetarVendasDoMes,
};
