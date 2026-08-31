// Fluxo de Caixa — ativado em 25/08/2026 (ver docs/04-alteracoes.md e
// docs/02-decisoes.md). NÃO tem tabela própria de movimentos: reaproveita
// exatamente as fontes já corretas do ERP — contas_pagar (lib/contasPagar.js),
// contas_receber (lib/contasReceber.js), despesas fixas ainda não geradas
// (lib/despesasFixas.js) e os recebimentos previstos do Mercado Livre
// (lib/recebimentosMl.js) — mesma filosofia de DRE/Recebimentos: nunca uma
// segunda fórmula financeira paralela, só reorganiza dado que já existe.
//
// REGRA MAIS IMPORTANTE DESTE MÓDULO (pedido explícito do usuário): uma
// despesa fixa que já gerou uma conta a pagar NUNCA entra de novo como
// "despesa fixa prevista" — ver calcularDespesasFixasPrevistasPorDia
// abaixo, que exclui qualquer ocorrência que já tenha uma linha em
// contas_pagar (despesa_fixa_id, vencimento). Exemplo do pedido: Aluguel
// R$3.000 já gerado em Contas a Pagar conta como R$3.000 (via contas a
// pagar), nunca R$6.000 (contas a pagar + despesa fixa de novo).
//
// SALDO INICIAL: o ERP não tem nenhuma integração bancária real — mesma
// regra já registrada em lib/visaoGeralPainel.js (nunca inventar saldo de
// banco). "Saldo atual"/"Saldo projetado" só existem se o usuário
// EXPLICITAMENTE informar um saldo de partida (fluxo_caixa_saldo_inicial);
// sem isso, os dois campos vêm `null` com o motivo, nunca um número
// inventado — REALIZADO e PROJETADO continuam sempre calculáveis
// (entradas/saídas do período), só o SALDO acumulado depende do saldo
// informado.
const pool = require('../db/pool');
const { diaBRT, dataCalendarioISO, inicioDoDiaBRTDeString } = require('./periodo');
const contasPagar = require('./contasPagar');
const contasReceber = require('./contasReceber');
const despesasFixas = require('./despesasFixas');
const { listarRecebimentosMl } = require('./recebimentosMl');
const contasBancarias = require('./contasBancarias');

function hojeBRT() { return diaBRT(new Date()); }
function round2(n) { return Math.round(n * 100) / 100; }
function pad2(n) { return String(n).padStart(2, '0'); }

function ultimoDiaDoMes(ano, mes) { return new Date(Date.UTC(ano, mes, 0)).getUTCDate(); }

function somarDiasData(dataStr, dias) {
  const [y, m, d] = dataStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}

const PERIODOS_VALIDOS = ['7d', '15d', '30d', 'mes', 'proximoMes', 'personalizado'];
const LIMITE_DIAS_PERSONALIZADO = 366; // trava simples pra nunca gerar uma série absurda por engano

// Período próprio do Fluxo de Caixa — deliberadamente SEPARADO do período do
// header (lib/periodo.js / window.CerneFiltro), que só tem hoje/ontem/7d/
// 30d/mes e nunca inclui datas futuras. Aqui o filtro é sempre olhando pra
// FRENTE (é uma projeção), por isso "7/15/30 dias" contam a partir de hoje
// (inclusive) em vez de "últimos N dias" como no resto do ERP.
function calcularPeriodoFluxoCaixa(chaveRecebida, { desde: desdeQuery, ate: ateQuery } = {}) {
  const hoje = hojeBRT();

  if (chaveRecebida === 'personalizado') {
    let desde = /^\d{4}-\d{2}-\d{2}$/.test(desdeQuery || '') ? desdeQuery : hoje;
    let ate = /^\d{4}-\d{2}-\d{2}$/.test(ateQuery || '') ? ateQuery : hoje;
    if (ate < desde) { const tmp = desde; desde = ate; ate = tmp; }
    if (somarDiasData(desde, LIMITE_DIAS_PERSONALIZADO) < ate) ate = somarDiasData(desde, LIMITE_DIAS_PERSONALIZADO);
    return { chave: 'personalizado', label: 'Período personalizado', desde, ate };
  }

  if (chaveRecebida === 'mes') {
    const [y, m] = hoje.split('-').map(Number);
    return { chave: 'mes', label: 'Este mês', desde: `${y}-${pad2(m)}-01`, ate: `${y}-${pad2(m)}-${pad2(ultimoDiaDoMes(y, m))}` };
  }

  if (chaveRecebida === 'proximoMes') {
    const [y, m] = hoje.split('-').map(Number);
    let py = y, pm = m + 1;
    if (pm > 12) { pm = 1; py++; }
    return { chave: 'proximoMes', label: 'Próximo mês', desde: `${py}-${pad2(pm)}-01`, ate: `${py}-${pad2(pm)}-${pad2(ultimoDiaDoMes(py, pm))}` };
  }

  const dias = { '7d': 7, '15d': 15, '30d': 30 }[chaveRecebida] || 7;
  const chave = ['7d', '15d', '30d'].includes(chaveRecebida) ? chaveRecebida : '7d';
  return { chave, label: `Próximos ${dias} dias`, desde: hoje, ate: somarDiasData(hoje, dias - 1) };
}

// ---------------- Saldo inicial (informado pelo usuário) ----------------

async function buscarSaldoInicial(empresaId) {
  const { rows } = await pool.query('SELECT * FROM fluxo_caixa_saldo_inicial WHERE empresa_id = $1', [empresaId]);
  if (!rows.length) return null;
  return {
    valor: Number(rows[0].valor),
    dataReferencia: dataCalendarioISO(rows[0].data_referencia),
    observacao: rows[0].observacao,
    atualizadoEm: rows[0].updated_at,
  };
}

function validarSaldoInicialPayload(body) {
  const errors = {};
  const empresaId = Number(body.empresaId);
  if (!empresaId) errors.empresaId = 'Selecione a empresa.';
  const valor = Number(body.valor);
  if (!Number.isFinite(valor)) errors.valor = 'Informe um valor numérico (pode ser negativo, se o caixa estiver no vermelho).';
  const dataReferencia = String(body.dataReferencia || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia)) errors.dataReferencia = 'Informe a data de referência do saldo.';
  return { errors, data: { empresaId, valor: round2(valor), dataReferencia, observacao: String(body.observacao || '').trim() || null } };
}

async function definirSaldoInicial(body) {
  const { errors, data } = validarSaldoInicialPayload(body);
  if (Object.keys(errors).length) return { errors };
  await pool.query(
    `INSERT INTO fluxo_caixa_saldo_inicial (empresa_id, valor, data_referencia, observacao)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (empresa_id) DO UPDATE SET valor = EXCLUDED.valor, data_referencia = EXCLUDED.data_referencia, observacao = EXCLUDED.observacao, updated_at = now()`,
    [data.empresaId, data.valor, data.dataReferencia, data.observacao]
  );
  return { saldoInicial: await buscarSaldoInicial(data.empresaId) };
}

// Saldo acumulado de ABERTURA do dia `diaAlvo` (ou seja: soma de todos os
// movimentos REALIZADOS — contas realmente pagas/recebidas — desde o dia
// seguinte à data de referência do saldo informado até o dia ANTERIOR a
// `diaAlvo`). Nunca inclui contas ainda pendentes: isso é "o que já
// aconteceu", a base sólida sobre a qual REALIZADO/PROJETADO do período
// exibido são somados por cima.
async function saldoDeAberturaEm(empresaId, saldoInicial, diaAlvo) {
  if (!saldoInicial) return null;
  if (diaAlvo <= saldoInicial.dataReferencia) return round2(saldoInicial.valor);

  const diaSeguinte = somarDiasData(saldoInicial.dataReferencia, 1);
  const diaAnterior = somarDiasData(diaAlvo, -1);
  const [{ rows: pagosRows }, { rows: recebidosRows }] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE empresa_id=$1 AND status='pago' AND data_pagamento BETWEEN $2 AND $3`, [empresaId, diaSeguinte, diaAnterior]),
    pool.query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_receber WHERE empresa_id=$1 AND status='recebido' AND data_recebida BETWEEN $2 AND $3`, [empresaId, diaSeguinte, diaAnterior]),
  ]);
  return round2(saldoInicial.valor + Number(recebidosRows[0].total) - Number(pagosRows[0].total));
}

// ---------------- Agregação diária (REALIZADO x PROJETADO) ----------------

function somarPorDia(rows, campoData) {
  const mapa = new Map();
  for (const r of rows) {
    const dia = dataCalendarioISO(r[campoData]);
    mapa.set(dia, round2((mapa.get(dia) || 0) + Number(r.valor)));
  }
  return mapa;
}

// Igual somarPorDia, mas qualquer data ANTERIOR a `hoje` é "trazida" pra
// dentro de hoje — uma conta pendente vencida ontem não desaparece do
// fluxo, ela vira uma saída/entrada esperada AGORA (mesmo raciocínio de
// "vencidas"/"atrasadas" nos cards de Contas a Pagar/Receber, só que aqui
// precisa de um dia pra ser plotada). Nunca empurra pra um dia FUTURO
// inventado — só resolve o caso de "já devia ter acontecido".
function somarPorDiaComDobraParaHoje(rows, campoData, hoje) {
  const mapa = new Map();
  for (const r of rows) {
    let dia = dataCalendarioISO(r[campoData]);
    if (dia < hoje) dia = hoje;
    mapa.set(dia, round2((mapa.get(dia) || 0) + Number(r.valor)));
  }
  return mapa;
}

// Ocorrências de despesa fixa ainda SEM conta a pagar gerada, dentro de
// [desde, ate] — a peça central da regra "nunca contar duas vezes" (ver
// comentário no topo do arquivo). Igual a somarPorDiaComDobraParaHoje: uma
// ocorrência com vencimento no passado (que ainda não foi gerada — ex: o
// ciclo de geração automática ainda não rodou) é trazida pra dentro de
// hoje, pro total desta função continuar batendo exatamente com o que a
// série diária soma em saidasPrevistas (nunca uma ocorrência "some" do
// total só porque caiu num dia já passado).
async function calcularDespesasFixasPrevistasPorDia({ empresaId, desde, ate, despesasAtivas, hoje }) {
  const ocorrencias = [];
  for (const d of despesasAtivas) {
    for (const vencimento of despesasFixas.ocorrenciasNoIntervalo(d, desde, ate)) {
      ocorrencias.push({ despesaFixaId: d.id, vencimento, valor: d.valor });
    }
  }
  if (!ocorrencias.length) return { porDia: new Map(), total: 0 };

  const idsDespesas = despesasAtivas.map((d) => d.id);
  const { rows: jaGeradas } = await pool.query(
    `SELECT despesa_fixa_id, vencimento::text AS vencimento FROM contas_pagar
     WHERE empresa_id = $1 AND despesa_fixa_id = ANY($2::int[]) AND vencimento BETWEEN $3 AND $4`,
    [empresaId, idsDespesas, desde, ate]
  );
  const jaGeradasSet = new Set(jaGeradas.map((r) => r.despesa_fixa_id + '|' + dataCalendarioISO(r.vencimento)));

  const porDia = new Map();
  let total = 0;
  for (const oc of ocorrencias) {
    const chave = oc.despesaFixaId + '|' + oc.vencimento;
    if (jaGeradasSet.has(chave)) continue; // já é uma conta a pagar de verdade — só contada lá
    const dia = hoje && oc.vencimento < hoje ? hoje : oc.vencimento;
    porDia.set(dia, round2((porDia.get(dia) || 0) + oc.valor));
    total = round2(total + oc.valor);
  }
  return { porDia, total };
}

async function gerarFluxoDeCaixa({ empresaId, periodoChave, desde: desdeQuery, ate: ateQuery }) {
  const periodo = calcularPeriodoFluxoCaixa(periodoChave, { desde: desdeQuery, ate: ateQuery });
  const { desde, ate } = periodo;
  const hoje = hojeBRT();

  const [
    saldoInicial,
    saldoBancario,
    { rows: pendentesPagar },
    { rows: pendentesReceber },
    { rows: pagosNoPeriodo },
    { rows: recebidosNoPeriodo },
    despesasAtivas,
    resumoPagar,
    resumoReceber,
  ] = await Promise.all([
    buscarSaldoInicial(empresaId),
    contasBancarias.saldoConsolidado(empresaId),
    pool.query(`SELECT vencimento, valor FROM contas_pagar WHERE empresa_id=$1 AND status='pendente'`, [empresaId]),
    pool.query(`SELECT data_prevista, valor FROM contas_receber WHERE empresa_id=$1 AND status='a_receber'`, [empresaId]),
    pool.query(`SELECT data_pagamento, valor FROM contas_pagar WHERE empresa_id=$1 AND status='pago' AND data_pagamento BETWEEN $2 AND $3`, [empresaId, desde, ate]),
    pool.query(`SELECT data_recebida, valor FROM contas_receber WHERE empresa_id=$1 AND status='recebido' AND data_recebida BETWEEN $2 AND $3`, [empresaId, desde, ate]),
    despesasFixas.listarDespesasFixas({ empresaId, ativo: true }),
    contasPagar.resumoContasPagar({ empresaId, desde, ate }),
    contasReceber.resumoContasReceber({ empresaId, desde, ate }),
  ]);

  const saldoBase = contasBancarias.resolverSaldoBase(saldoBancario, saldoInicial);
  const usaSaldoBancario = !!(saldoBase && saldoBase.fonte === 'bancario');
  const inicioPrevisao = usaSaldoBancario && desde > hoje ? hoje : desde;
  const { porDia: despesasFixasPorDia } = await calcularDespesasFixasPrevistasPorDia({ empresaId, desde: inicioPrevisao, ate, despesasAtivas, hoje });

  // Recebimentos previstos de marketplace (Mercado Livre — mesma fonte de
  // lib/recebimentosMl.js/tela Recebimentos): SEM data de liberação real
  // (ver lib/recebimentosMl.js), por isso entram só como um TOTAL do
  // período (não são plotados num dia específico do gráfico — nunca
  // inventamos a data em que o marketplace vai liberar o dinheiro).
  const desdeInstant = inicioDoDiaBRTDeString(desde);
  const ateInstant = inicioDoDiaBRTDeString(somarDiasData(ate, 1));
  const recebimentosMl = await listarRecebimentosMl({ empresaId, desde: desdeInstant, ate: ateInstant });
  let recebimentosMlPrevistoTotal = 0;
  for (const r of recebimentosMl) {
    if (r.valorLiquidoEsperado !== null) recebimentosMlPrevistoTotal = round2(recebimentosMlPrevistoTotal + r.valorLiquidoEsperado);
  }

  const mapaPagos = somarPorDia(pagosNoPeriodo, 'data_pagamento');
  const mapaRecebidos = somarPorDia(recebidosNoPeriodo, 'data_recebida');
  const mapaPagarProjetado = somarPorDiaComDobraParaHoje(pendentesPagar, 'vencimento', hoje);
  const mapaReceberProjetado = somarPorDiaComDobraParaHoje(pendentesReceber, 'data_prevista', hoje);

  const aberturaDoPeriodo = usaSaldoBancario ? null : await saldoDeAberturaEm(empresaId, saldoInicial, desde);
  const saldoAtual = usaSaldoBancario
    ? round2(saldoBase.valor)
    : await saldoDeAberturaEm(empresaId, saldoInicial, somarDiasData(hoje, 1));

  const dias = [];
  let cursor = desde;
  let acumulado = aberturaDoPeriodo; // pode ser null (sem saldo conhecido)
  if (usaSaldoBancario && desde > hoje) {
    // Para um período que começa no futuro (ex.: próximo mês), parte do saldo
    // bancário atual e aplica somente previsões entre hoje e a véspera do período.
    acumulado = round2(saldoAtual);
    let pre = hoje;
    while (pre < desde) {
      acumulado = round2(acumulado
        + round2(mapaReceberProjetado.get(pre) || 0)
        - round2(mapaPagarProjetado.get(pre) || 0)
        - round2(despesasFixasPorDia.get(pre) || 0));
      pre = somarDiasData(pre, 1);
    }
  }
  let entradasPrevistasTotal = 0, saidasPrevistasTotal = 0, entradasRealizadasTotal = 0, saidasRealizadasTotal = 0, despesasFixasPrevistasTotal = 0;

  while (cursor <= ate) {
    const passado = cursor < hoje;
    if (usaSaldoBancario && cursor === hoje) acumulado = round2(saldoAtual);
    const entradaRealizada = round2(mapaRecebidos.get(cursor) || 0);
    const saidaRealizada = round2(mapaPagos.get(cursor) || 0);
    const entradaProjetada = passado ? 0 : round2(mapaReceberProjetado.get(cursor) || 0);
    const saidaProjetadaContas = passado ? 0 : round2(mapaPagarProjetado.get(cursor) || 0);
    const saidaProjetadaDespesasFixas = passado ? 0 : round2(despesasFixasPorDia.get(cursor) || 0);
    const saidaProjetada = round2(saidaProjetadaContas + saidaProjetadaDespesasFixas);

    entradasRealizadasTotal = round2(entradasRealizadasTotal + entradaRealizada);
    saidasRealizadasTotal = round2(saidasRealizadasTotal + saidaRealizada);
    entradasPrevistasTotal = round2(entradasPrevistasTotal + entradaProjetada);
    saidasPrevistasTotal = round2(saidasPrevistasTotal + saidaProjetada);
    despesasFixasPrevistasTotal = round2(despesasFixasPrevistasTotal + saidaProjetadaDespesasFixas);

    if (usaSaldoBancario && passado) {
      acumulado = null; // saldo bancário é uma fotografia atual; não inventamos saldo histórico para dias anteriores ao extrato
    } else if (acumulado !== null) {
      // Com saldo bancário, entradas/saídas REALIZADAS já estão refletidas no saldo do extrato e nunca são somadas outra vez.
      acumulado = usaSaldoBancario
        ? round2(acumulado + entradaProjetada - saidaProjetada)
        : round2(acumulado + entradaRealizada + entradaProjetada - saidaRealizada - saidaProjetada);
    }

    dias.push({
      dia: cursor,
      ehHoje: cursor === hoje,
      ehPassado: passado,
      realizado: { entradas: entradaRealizada, saidas: saidaRealizada },
      projetado: { entradas: entradaProjetada, saidas: saidaProjetada, despesasFixas: saidaProjetadaDespesasFixas },
      saldoAcumulado: acumulado,
    });
    cursor = somarDiasData(cursor, 1);
  }

  const saldoProjetado = dias.length ? dias[dias.length - 1].saldoAcumulado : acumulado;

  return {
    periodo: { chave: periodo.chave, label: periodo.label, desde, ate },
    saldoInicial,
    saldoBancario,
    saldoFonte: saldoBase ? saldoBase.fonte : null,
    cards: {
      saldoAtual: saldoAtual === null ? { valor: null, motivo: 'sem_saldo_conhecido' } : { valor: saldoAtual, motivo: null },
      entradasPrevistas: round2(entradasPrevistasTotal),
      saidasPrevistas: round2(saidasPrevistasTotal),
      saldoProjetado: saldoProjetado === null || saldoProjetado === undefined
        ? { valor: null, motivo: 'sem_saldo_conhecido' }
        : { valor: saldoProjetado, motivo: null },
      contasVencidas: round2(resumoPagar.vencidas + resumoReceber.atrasado),
    },
    resumoFormula: {
      // Exatamente a fórmula pedida: saldo inicial/atual + contas a receber
      // + recebimentos previstos de marketplace - contas a pagar - despesas
      // fixas previstas = saldo projetado. "Contas a receber"/"Contas a
      // pagar" aqui são só o que está PENDENTE dentro do período mostrado
      // (entradasPrevistas/saidasPrevistas acima) — nunca um total "pra
      // sempre" (esse é o saldo em aberto de Contas a Pagar/Receber, um
      // conceito diferente e já mostrado nas telas delas).
      saldoInicialOuAtual: saldoAtual === null ? { valor: null, motivo: 'sem_saldo_conhecido' } : { valor: saldoAtual, motivo: null },
      contasAReceber: round2(entradasPrevistasTotal),
      recebimentosPrevistosMarketplaces: recebimentosMlPrevistoTotal,
      contasAPagar: round2(saidasPrevistasTotal - despesasFixasPrevistasTotal),
      despesasFixasPrevistas: despesasFixasPrevistasTotal,
      saldoProjetado: saldoProjetado === null || saldoProjetado === undefined
        ? { valor: null, motivo: 'sem_saldo_conhecido' }
        : { valor: saldoProjetado, motivo: null },
    },
    realizadoNoPeriodo: { entradas: entradasRealizadasTotal, saidas: saidasRealizadasTotal },
    recebimentosMarketplaces: {
      total: recebimentosMlPrevistoTotal,
      quantidade: recebimentosMl.length,
      semDataDeLiberacao: true, // ver comentário acima — nunca plotado num dia específico
    },
    serieDiaria: dias,
  };
}

module.exports = {
  PERIODOS_VALIDOS,
  calcularPeriodoFluxoCaixa,
  buscarSaldoInicial,
  definirSaldoInicial,
  gerarFluxoDeCaixa,
  saldoDeAberturaEm,
  calcularDespesasFixasPrevistasPorDia,
};
