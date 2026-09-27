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

// ---------------------------------------------------------------------
// Interpreta o período que a pessoa escreveu na própria mensagem do
// Telegram (ex: "hoje", "essa semana", "agosto", "de 01/08 a 15/08") —
// pedido explícito do usuário em 21/09/2026: como o Telegram não tem a
// telinha de escolher mês/período que existe no site (header), ele disse
// "EU SEMPRE VOU FALAR A DATA QUE QUERO RELATÓRIOS", então quem descobre o
// período é o texto da própria pergunta, não um padrão fixo. Mantido AQUI
// (dentro de lib/periodo.js, em vez de um arquivo novo separado) de
// propósito: um arquivo novo dentro de lib/ia/ ficou se perdendo repetidas
// vezes no processo manual de subir os arquivos pro GitHub (ver
// 04-alteracoes.md) — juntar num arquivo que já existe e já sobe certo
// elimina esse problema de vez.
//
// Regra de honestidade deste projeto (nunca inventar/adivinhar dado): esta
// função NUNCA cria uma regra de cálculo de período nova — ela só decide
// QUAIS datas usar e devolve exatamente o mesmo `periodoChave`/`desde`/
// `ate` que `calcularPeriodo` acima já aceita. Quando não reconhece
// nenhuma data no texto, ela NUNCA finge ter entendido — devolve
// `reconhecido:false` e um período padrão (mês atual), pra quem chamar
// avisar a pessoa claramente que usou um padrão em vez de adivinhar.
const NOMES_MES = {
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  marco: 3, mar: 3,
  abril: 4, abr: 4,
  maio: 5, mai: 5,
  junho: 6, jun: 6,
  julho: 7, jul: 7,
  agosto: 8, ago: 8,
  setembro: 9, set: 9,
  outubro: 10, out: 10,
  novembro: 11, nov: 11,
  dezembro: 12, dez: 12,
};

function semAcentoTelegram(str) {
  return String(str).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function pad2Telegram(n) {
  return String(n).padStart(2, '0');
}

// Última data de calendário (1-31) de um mês — matemática de calendário
// pura (não depende de fuso horário).
function ultimoDiaDoMesTelegram(ano, mes1a12) {
  return new Date(ano, mes1a12, 0).getDate();
}

// 'YYYY-MM-DD' válida de verdade (não só no formato) — mesma técnica de
// round-trip por diaBRT já usada em lib/ia/ferramentas.js#parseDataYYYYMMDD,
// pra nunca aceitar algo como "2026-02-30".
function dataValidaISOTelegram(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const instante = inicioDoDiaBRTDeString(str);
  return !Number.isNaN(instante.getTime()) && diaBRT(instante) === str;
}

function anoMesAtualTelegram(agora) {
  const [ano, mes] = diaBRT(inicioDoMesBRT(agora)).split('-').map(Number);
  return { ano, mes };
}

// Devolve { periodoChave, desde?, ate?, reconhecido, descricaoUsada } —
// `desde`/`ate` (strings 'YYYY-MM-DD') só vêm preenchidos quando
// periodoChave === 'personalizado' (mesmo contrato de calcularPeriodo).
function resolverPeriodoDoTexto(textoOriginal, agora = new Date()) {
  const texto = semAcentoTelegram(String(textoOriginal || '').toLowerCase());
  const { ano: anoAtual } = anoMesAtualTelegram(agora);

  // 1) Intervalo explícito: "de 01/08 a 15/08", "01/08/2026 até 15/08/2026"
  const RE_INTERVALO = /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*(?:a|ate|até|-|e)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/;
  const mIntervalo = RE_INTERVALO.exec(texto);
  if (mIntervalo) {
    const [, d1, m1, a1, d2, m2, a2] = mIntervalo;
    const desde = `${a1 ? a1 : anoAtual}-${pad2Telegram(m1)}-${pad2Telegram(d1)}`;
    const ate = `${a2 ? a2 : anoAtual}-${pad2Telegram(m2)}-${pad2Telegram(d2)}`;
    if (dataValidaISOTelegram(desde) && dataValidaISOTelegram(ate)) {
      return { periodoChave: 'personalizado', desde, ate, reconhecido: true, descricaoUsada: `de ${desde} até ${ate}` };
    }
  }

  // 2) Um dia específico: "dia 05/08", "no dia 5/8/2026"
  const RE_DIA_UNICO = /\bdia\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/;
  const mDia = RE_DIA_UNICO.exec(texto);
  if (mDia) {
    const [, d, m, a] = mDia;
    const data = `${a ? a : anoAtual}-${pad2Telegram(m)}-${pad2Telegram(d)}`;
    if (dataValidaISOTelegram(data)) {
      return { periodoChave: 'personalizado', desde: data, ate: data, reconhecido: true, descricaoUsada: `o dia ${data}` };
    }
  }

  // 3) Palavras-chave diretas (mesmos períodos já prontos do site)
  if (/\bhoje\b/.test(texto)) {
    return { periodoChave: 'hoje', reconhecido: true, descricaoUsada: 'hoje' };
  }
  if (/\bontem\b/.test(texto)) {
    return { periodoChave: 'ontem', reconhecido: true, descricaoUsada: 'ontem' };
  }
  if (/ultim[oa]s?\s*7\s*dias|essa semana|esta semana/.test(texto)) {
    return { periodoChave: '7d', reconhecido: true, descricaoUsada: 'últimos 7 dias' };
  }
  if (/ultim[oa]s?\s*30\s*dias/.test(texto)) {
    return { periodoChave: '30d', reconhecido: true, descricaoUsada: 'últimos 30 dias' };
  }
  if (/mes passado|mes anterior/.test(texto)) {
    const { ano, mes } = anoMesAtualTelegram(agora);
    let mesPassado = mes - 1, anoPassado = ano;
    if (mesPassado === 0) { mesPassado = 12; anoPassado -= 1; }
    const desde = `${anoPassado}-${pad2Telegram(mesPassado)}-01`;
    const ate = `${anoPassado}-${pad2Telegram(mesPassado)}-${pad2Telegram(ultimoDiaDoMesTelegram(anoPassado, mesPassado))}`;
    return { periodoChave: 'personalizado', desde, ate, reconhecido: true, descricaoUsada: `${desde} até ${ate} (mês passado)` };
  }
  if (/\b(esse mes|este mes|mes atual|mes corrente)\b/.test(texto)) {
    return { periodoChave: 'mes', reconhecido: true, descricaoUsada: 'este mês' };
  }

  // 4) Nome de mês solto: "agosto", "agosto de 2026", "agosto/2026"
  for (const nome of Object.keys(NOMES_MES)) {
    const re = new RegExp(`\\b${nome}\\b(?:\\s*(?:de|/)?\\s*(\\d{4}))?`);
    const m = re.exec(texto);
    if (m) {
      const mesIdx = NOMES_MES[nome];
      const ano = m[1] ? Number(m[1]) : anoAtual;
      const desde = `${ano}-${pad2Telegram(mesIdx)}-01`;
      const ate = `${ano}-${pad2Telegram(mesIdx)}-${pad2Telegram(ultimoDiaDoMesTelegram(ano, mesIdx))}`;
      return { periodoChave: 'personalizado', desde, ate, reconhecido: true, descricaoUsada: `${desde} até ${ate}` };
    }
  }

  // Nada reconhecido — nunca finge ter entendido: devolve um padrão (mês
  // atual, o mesmo padrão do site) marcado como `reconhecido:false`.
  return { periodoChave: 'mes', reconhecido: false, descricaoUsada: 'este mês (padrão, nenhuma data foi identificada na mensagem)' };
}

module.exports = { PERIODOS, calcularPeriodo, diaBRT, horaBRT, dataCalendarioISO, inicioDoDiaBRTDeString, periodoParaDatasBRT, inicioDoMesBRT, resolverPeriodoDoTexto };
