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
  // Adicionado em 12/09/2026 (pedido explícito do usuário: poder escolher
  // qualquer intervalo de datas — "do dia 1 ao dia 15", não só os períodos
  // prontos — em TODA tela do ERP que tem filtro de período, não só
  // Fluxo de Caixa/DRE, que já tinham essa opção com seu próprio período
  // separado). Mesmo nome/convenção já usado por lib/dre.js#calcularPeriodoDre
  // e lib/fluxoCaixa.js#calcularPeriodoFluxoCaixa — aqui centralizado pra
  // valer pra Visão Geral, Pedidos, Contas a Pagar/Receber, Faturamento,
  // Recebimentos, Notas Fiscais, Relatórios, Performance de Anúncios,
  // Visitas e Conversão, Margem por Anúncio, Ads e IA Gestora de uma vez só
  // (todas usam esta mesma função `calcularPeriodo`), sem duplicar a lógica
  // de data em cada tela.
  personalizado: { chave: 'personalizado', label: 'Período personalizado' },
};

// Trava simples pra nunca gerar uma consulta/série absurda por engano —
// mesmo valor/racional já usado por lib/fluxoCaixa.js.
const LIMITE_DIAS_PERSONALIZADO = 366;
const FORMATO_DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

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

// Devolve a HORA (0-23) em Brasília de um instante — usado pelo agendamento
// automático da Daily dos Agentes (lib/ia/dailyScheduler.js) pra saber
// quando já passou do horário configurado de envio, sem depender do fuso do
// servidor (Render roda em UTC).
function horaBRT(instante) {
  const brt = new Date(new Date(instante).getTime() - BRT_OFFSET_MS);
  return brt.getUTCHours();
}

// Converte uma data de calendário ('YYYY-MM-DD', pensada como um dia em
// America/Sao_Paulo) no instante UTC correspondente a 00:00:00 BRT daquele
// dia. Usado pela sincronização histórica (lib/mlSync.js) para andar dia a
// dia — mesmo fuso fixo (UTC-3) usado no resto deste arquivo.

// Normaliza uma coluna SQL DATE para o dia de calendário (YYYY-MM-DD), sem
// aplicar conversão de fuso. O `pg` pode entregar DATE como string OU como
// objeto Date em horário local. DATE não representa um instante; representa
// apenas um dia. Por isso nunca use String(date).slice(0,10) nem toISOString()
// aqui: ambos podem produzir texto não-ISO ou deslocar o dia por timezone.
function dataCalendarioISO(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor.trim());
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return valor.getFullYear() + '-' + p(valor.getMonth() + 1) + '-' + p(valor.getDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(valor));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function inicioDoDiaBRTDeString(dataStr) {
  return new Date(dataStr + 'T00:00:00.000-03:00');
}

// `opts.desde`/`opts.ate` (strings 'YYYY-MM-DD', pensadas como dias em
// America/Sao_Paulo) só são usadas quando `chaveRecebida === 'personalizado'`
// — nos demais períodos continuam ignoradas, comportamento idêntico ao de
// antes desta mudança (nenhuma tela que já chamava `calcularPeriodo(chave)`
// sem o segundo argumento precisa mudar nada). Datas ausentes/inválidas
// caem no padrão de 30 dias, nunca quebram a tela.
function calcularPeriodo(chaveRecebida, { desde: desdeQuery, ate: ateQuery } = {}) {
  const chave = PERIODOS[chaveRecebida] ? chaveRecebida : '30d';
  const def = PERIODOS[chave];
  const agora = new Date();
  let desde, ate;
  if (chave === 'personalizado') {
    const desdeValida = FORMATO_DATA_ISO.test(desdeQuery || '') ? desdeQuery : null;
    const ateValida = FORMATO_DATA_ISO.test(ateQuery || '') ? ateQuery : null;
    if (!desdeValida || !ateValida) {
      // Sem as duas datas, cai pro padrão de 30 dias — mesma regra de
      // fallback de uma chave desconhecida, nunca uma tela quebrada.
      const def30 = PERIODOS['30d'];
      desde = new Date(agora.getTime() - def30.dias * UM_DIA_MS);
      return { chave: '30d', label: def30.label, desde, ate: agora };
    }
    let inicio = inicioDoDiaBRTDeString(desdeValida);
    let fim = inicioDoDiaBRTDeString(ateValida);
    if (fim < inicio) { const tmp = inicio; inicio = fim; fim = tmp; } // datas trocadas — inverte, nunca dá erro
    const limite = new Date(inicio.getTime() + LIMITE_DIAS_PERSONALIZADO * UM_DIA_MS);
    if (fim > limite) fim = limite;
    desde = inicio;
    ate = new Date(fim.getTime() + UM_DIA_MS); // limite exclusivo (fim do dia "até"), mesma convenção do resto do arquivo
    return { chave: 'personalizado', label: def.label, desde, ate };
  } else if (chave === 'hoje') {
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

module.exports = { PERIODOS, calcularPeriodo, diaBRT, horaBRT, dataCalendarioISO, inicioDoDiaBRTDeString, periodoParaDatasBRT, inicioDoMesBRT };
