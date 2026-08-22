// Período usado pelos filtros de Visão Geral, Pedidos e Financeiro — a MESMA
// definição de intervalo de datas para as três telas (nunca calculado de um
// jeito em uma tela e de outro jeito em outra).
//
// Os limites de "Hoje" e "Este mês" usam o fuso horário de Brasília
// (UTC-3, fixo — o Brasil não usa mais horário de verão desde 2019), já que
// o usuário e as vendas são daqui. "Últimos 7/30 dias" são uma janela
// corrida (agora menos N dias), não dias de calendário.
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

const PERIODOS = {
  hoje: { chave: 'hoje', label: 'Hoje' },
  '7d': { chave: '7d', label: 'Últimos 7 dias', dias: 7 },
  '30d': { chave: '30d', label: 'Últimos 30 dias', dias: 30 },
  mes: { chave: 'mes', label: 'Este mês' },
};

// Converte um instante (UTC) no início do dia em Brasília, devolvendo o
// instante UTC correspondente a 00:00 BRT daquele dia.
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

function calcularPeriodo(chaveRecebida) {
  const chave = PERIODOS[chaveRecebida] ? chaveRecebida : '30d';
  const def = PERIODOS[chave];
  const agora = new Date();
  let desde;
  if (chave === 'hoje') desde = inicioDoDiaBRT(agora);
  else if (chave === 'mes') desde = inicioDoMesBRT(agora);
  else desde = new Date(agora.getTime() - def.dias * 24 * 60 * 60 * 1000);
  return { chave, label: def.label, desde, ate: agora };
}

module.exports = { PERIODOS, calcularPeriodo, diaBRT };
