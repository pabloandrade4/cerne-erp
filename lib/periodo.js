// Período usado pelos filtros de Visão Geral, Pedidos e Financeiro — a MESMA
// definição de intervalo de datas para as três telas (nunca calculado de um
// jeito em uma tela e de outro jeito em outra).
//
// Timezone: America/Sao_Paulo. Os limites de "Hoje", "Ontem" e "Este mês" usam
// o fuso horário de Brasília (UTC-3, fixo — o Brasil não usa mais horário de
// verão desde 2019), já que o usuário e as vendas são daqui. "Últimos 7/30
// dias" são uma janela corrida (agora menos N dias), não dias de calendário.
//
// "Hoje" e "Ontem" usam início E fim explícitos do dia (00:00:00 até
// 23:59:59.999 em America/Sao_Paulo) — não "agora" como limite superior —
// para o período ficar sempre exatamente o dia pedido, nunca vazando pedido
// de outro dia por causa de fuso horário.
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;
const UM_DIA_MS = 24 * 60 * 60 * 1000;

const PERIODOS = {
  hoje: { chave: 'hoje', label: 'Hoje' },
  ontem: { chave: 'ontem', label: 'Ontem' },
  '7d': { chave: '7d', label: 'Últimos 7 dias', dias: 7 },
  '30d': { chave: '30d', label: 'Últimos 30 dias', dias: 30 },
  mes: { chave: 'mes', label: 'Este mês' },
};

// Converte um instante (UTC) no início do dia em Brasília, devolvendo o
// instante UTC correspondente a 00:00:00 BRT daquele dia.
function inicioDoDiaBRT(instante) {
  const brt = new Date(instante.getTime() - BRT_OFFSET_MS);
  return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()) + BRT_OFFSET_MS);
}

function inicioDoMesBRT(instante) {
  const brt = new Date(instante.getTime() - BRT_OFFSET_MS);
  return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), 1) + BRT_OFFSET_MS);
}

// Devolve o dia (YYYY-MM-DD) em Brasília de um instante — usado para agrupar
// a série diária do gráfico de Visão Geral.
function diaBRT(instante) {
  const brt = new Date(new Date(instante).getTime() - BRT_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return brt.getUTCFullYear() + '-' + p(brt.getUTCMonth() + 1) + '-' + p(brt.getUTCDate());
}

// Converte uma data de calendário ('YYYY-MM-DD', pensada como um dia em
// America/Sao_Paulo) no instante UTC correspondente a 00:00:00 BRT daquele
// dia. Usado pela sincronização histórica (lib/mlSync.js) para andar dia a
// dia — mesmo fuso fixo (UTC-3) usado no resto deste arquivo.
function inicioDoDiaBRTDeString(dataStr) {
  return new Date(dataStr + 'T00:00:00.000-03:00');
}

function calcularPeriodo(chaveRecebida) {
  const chave = PERIODOS[chaveRecebida] ? chaveRecebida : '30d';
  const def = PERIODOS[chave];
  const agora = new Date();
  let desde, ate;
  if (chave === 'hoje') {
    // [00:00:00 de hoje, 00:00:00 de amanhã) em BRT — cobre o dia inteiro,
    // nunca deixa pedido de ontem entrar nem depende de "agora" como limite.
    desde = inicioDoDiaBRT(agora);
    ate = new Date(desde.getTime() + UM_DIA_MS);
  } else if (chave === 'ontem') {
    // [00:00:00 de ontem, 00:00:00 de hoje) em BRT.
    const inicioHoje = inicioDoDiaBRT(agora);
    desde = new Date(inicioHoje.getTime() - UM_DIA_MS);
    ate = inicioHoje;
  } else if (chave === 'mes') {
    desde = inicioDoMesBRT(agora);
    ate = agora;
  } else {
    desde = new Date(agora.getTime() - def.dias * UM_DIA_MS);
    ate = agora;
  }
  return { chave, label: def.label, desde, ate };
}

// Converte um intervalo de instantes [desde, ate) — o formato devolvido por
// calcularPeriodo — no intervalo de DATAS de calendário BRT
// correspondente, inclusive nas duas pontas ('YYYY-MM-DD'). Usado por
// telas que filtram por uma coluna DATE (não TIMESTAMPTZ), como Contas a
// Pagar/Receber (vencimento/data prevista) — adicionado em 24/08/2026, ver
// docs/04-alteracoes.md. `ate` é subtraído de 1ms antes de converter
// porque calcularPeriodo devolve um limite EXCLUSIVO (o início do dia
// seguinte); sem isso, o último dia do período ficaria de fora.
function periodoParaDatasBRT({ desde, ate }) {
  return { desde: diaBRT(desde), ate: diaBRT(new Date(ate.getTime() - 1)) };
}

module.exports = { PERIODOS, calcularPeriodo, diaBRT, inicioDoDiaBRTDeString, periodoParaDatasBRT };
