// Interpreta o período que a pessoa escreveu na própria mensagem do Telegram
// (ex: "hoje", "essa semana", "agosto", "de 01/08 a 15/08") — pedido explícito
// do usuário em 21/09/2026: como o Telegram não tem a telinha de escolher
// mês/período que existe no site (header), ele disse "EU SEMPRE VOU FALAR A
// DATA QUE QUERO RELATÓRIOS", então quem descobre o período é o texto da
// própria pergunta, não um padrão fixo.
//
// Regra de honestidade deste projeto (nunca inventar/adivinhar dado): esta
// função NUNCA cria uma regra de cálculo de período nova — ela só decide QUAIS
// datas usar e devolve exatamente o mesmo `periodoChave`/`desde`/`ate` que
// `lib/periodo.js#calcularPeriodo` já aceita (o mesmo usado pelo filtro de
// período do site). Quando não reconhece nenhuma data no texto, ela NUNCA
// finge ter entendido — devolve `reconhecido:false` e um período padrão (mês
// atual), pra quem chamar avisar a pessoa claramente que usou um padrão em
// vez de adivinhar.
const { diaBRT, inicioDoDiaBRTDeString, inicioDoMesBRT } = require('../periodo');

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

function semAcento(str) {
  return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Última data de calendário (1-31) de um mês — matemática de calendário pura
// (não depende de fuso horário: Date(ano, mes, 0) sempre devolve o último dia
// do mês anterior ao índice `mes`, então passar o mês 1-based direto já dá o
// último dia do mês pedido).
function ultimoDiaDoMes(ano, mes1a12) {
  return new Date(ano, mes1a12, 0).getDate();
}

// 'YYYY-MM-DD' válida de verdade (não só no formato) — mesma técnica de
// round-trip por diaBRT já usada em lib/ia/ferramentas.js#parseDataYYYYMMDD,
// pra nunca aceitar algo como "2026-02-30".
function dataValidaISO(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const instante = inicioDoDiaBRTDeString(str);
  return !Number.isNaN(instante.getTime()) && diaBRT(instante) === str;
}

function anoMesAtual(agora) {
  const [ano, mes] = diaBRT(inicioDoMesBRT(agora)).split('-').map(Number);
  return { ano, mes };
}

// Devolve { periodoChave, desde?, ate?, reconhecido, descricaoUsada } —
// `desde`/`ate` (strings 'YYYY-MM-DD') só vêm preenchidos quando
// periodoChave === 'personalizado' (mesmo contrato de calcularPeriodo).
function resolverPeriodoDoTexto(textoOriginal, agora = new Date()) {
  const texto = semAcento(String(textoOriginal || '').toLowerCase());
  const { ano: anoAtual } = anoMesAtual(agora);

  // 1) Intervalo explícito: "de 01/08 a 15/08", "01/08/2026 até 15/08/2026"
  const RE_INTERVALO = /(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s*(?:a|ate|até|-|e)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/;
  const mIntervalo = RE_INTERVALO.exec(texto);
  if (mIntervalo) {
    const [, d1, m1, a1, d2, m2, a2] = mIntervalo;
    const desde = `${a1 ? a1 : anoAtual}-${pad2(m1)}-${pad2(d1)}`;
    const ate = `${a2 ? a2 : anoAtual}-${pad2(m2)}-${pad2(d2)}`;
    if (dataValidaISO(desde) && dataValidaISO(ate)) {
      return { periodoChave: 'personalizado', desde, ate, reconhecido: true, descricaoUsada: `de ${desde} até ${ate}` };
    }
  }

  // 2) Um dia específico: "dia 05/08", "no dia 5/8/2026"
  const RE_DIA_UNICO = /\bdia\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/;
  const mDia = RE_DIA_UNICO.exec(texto);
  if (mDia) {
    const [, d, m, a] = mDia;
    const data = `${a ? a : anoAtual}-${pad2(m)}-${pad2(d)}`;
    if (dataValidaISO(data)) {
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
    const { ano, mes } = anoMesAtual(agora);
    let mesPassado = mes - 1, anoPassado = ano;
    if (mesPassado === 0) { mesPassado = 12; anoPassado -= 1; }
    const desde = `${anoPassado}-${pad2(mesPassado)}-01`;
    const ate = `${anoPassado}-${pad2(mesPassado)}-${pad2(ultimoDiaDoMes(anoPassado, mesPassado))}`;
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
      const desde = `${ano}-${pad2(mesIdx)}-01`;
      const ate = `${ano}-${pad2(mesIdx)}-${pad2(ultimoDiaDoMes(ano, mesIdx))}`;
      return { periodoChave: 'personalizado', desde, ate, reconhecido: true, descricaoUsada: `${desde} até ${ate}` };
    }
  }

  // Nada reconhecido — nunca finge ter entendido: devolve um padrão (mês
  // atual, o mesmo padrão do site) marcado como `reconhecido:false`, pra
  // quem chamar avisar a pessoa que usou um período padrão.
  return { periodoChave: 'mes', reconhecido: false, descricaoUsada: 'este mês (padrão, nenhuma data foi identificada na mensagem)' };
}

module.exports = { resolverPeriodoDoTexto };
