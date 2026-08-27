// Fluxo de Caixa — ativado em 25/08/2026, reescrito na ETAPA 3 em
// 27/08/2026 (ver docs/04-alteracoes.md e docs/02-decisoes.md).
//
// ARQUITETURA (ETAPA 3 — decisão explícita do usuário, mudando a etapa
// anterior): o REALIZADO passa a vir SEMPRE de `extrato_movimentos`
// (dinheiro que passou de verdade pelo banco — conciliado ou não). NUNCA
// MAIS de `contas_pagar.status='pago'`, `contas_receber.status='recebido'`
// ou `recebimentos_marketplace` — essas três fontes continuam existindo e
// continuam importantes, só que exclusivamente para o PREVISTO (o que
// ainda vai acontecer) e para conciliação/comparação. Mesma filosofia de
// sempre (nunca uma segunda fórmula financeira paralela), só que agora a
// fórmula única do REALIZADO é "o banco", não mais "o que foi marcado como
// pago/recebido no ERP" — porque o usuário pode ter um PIX/tarifa/imposto
// que aconteceu de verdade sem nunca ter sido lançado em contas_pagar.
//
// REGRA CENTRAL (nunca duplicar): REALIZADO (extrato_movimentos) e
// PREVISTO (contas_pagar/contas_receber pendentes) são fontes DISJUNTAS —
// nunca a mesma query, nunca o mesmo valor contado duas vezes. Quando uma
// conta prevista é conciliada com um movimento do banco, ela desaparece do
// PREVISTO (status vira pago/recebido, sai do filtro status='pendente'/
// 'a_receber') — o dinheiro já estava no REALIZADO desde que o extrato foi
// importado, com ou sem conciliação. A conciliação nunca "liga o
// realizado" (isso é automático, vem do banco); ela só "desliga o
// previsto".
//
// SALDO INICIAL: passa a ser POR CONTA BANCÁRIA (`fluxo_caixa_saldo_inicial_conta`
// — ver db/schema.sql). A tabela antiga `fluxo_caixa_saldo_inicial` (só por
// empresa) é preservada como LEGADO/histórico — nunca lida por este
// arquivo a partir de agora (nenhum valor é migrado/distribuído
// automaticamente entre contas: o usuário pediu explicitamente pra nunca
// inventar uma composição bancária que não existe de verdade). Sem saldo
// inicial configurado (numa conta, ou consolidado), os campos de saldo vêm
// `null` com o motivo — nunca um número inventado; entradas/saídas/
// movimentações/previsto continuam sempre calculáveis.
//
// REGRA MAIS IMPORTANTE DO PREVISTO (inalterada desde 25/08/2026): uma
// despesa fixa que já gerou uma conta a pagar NUNCA entra de novo como
// "despesa fixa prevista" — ver calcularDespesasFixasPrevistasPorDia
// abaixo.
const pool = require('../db/pool');
const { diaBRT, inicioDoDiaBRTDeString } = require('./periodo');
const contasPagar = require('./contasPagar');
const contasReceber = require('./contasReceber');
const despesasFixas = require('./despesasFixas');
const { listarRecebimentosMl } = require('./recebimentosMl');

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
// (inclusive) em vez de "últimos N dias" como no resto do ERP. Só
// "personalizado" pode olhar pra trás (por isso é o único caso onde dias
// REALIZADOS de antes de hoje aparecem na série diária).
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

// ---------------- Saldo inicial LEGADO (só por empresa, pré-ETAPA 3) ----------------
// Preservado tal como estava, SEM NENHUMA ALTERAÇÃO de comportamento —
// nunca mais lido por gerarFluxoDeCaixa (ver cabeçalho do arquivo). Fica
// só como histórico/auditoria; a rota GET /saldo-inicial (legado) continua
// funcionando pra quem quiser consultar o que tinha sido informado antes.

async function buscarSaldoInicial(empresaId) {
  const { rows } = await pool.query('SELECT * FROM fluxo_caixa_saldo_inicial WHERE empresa_id = $1', [empresaId]);
  if (!rows.length) return null;
  return {
    valor: Number(rows[0].valor),
    dataReferencia: String(rows[0].data_referencia).slice(0, 10),
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

// ---------------- Saldo inicial POR CONTA (ETAPA 3) ----------------

async function buscarSaldoInicialConta(contaBancariaId) {
  const { rows } = await pool.query('SELECT * FROM fluxo_caixa_saldo_inicial_conta WHERE conta_bancaria_id = $1', [contaBancariaId]);
  if (!rows.length) return null;
  return {
    valor: Number(rows[0].valor),
    referenciaEm: rows[0].referencia_em,
    observacao: rows[0].observacao,
    atualizadoEm: rows[0].updated_at,
  };
}

function validarSaldoInicialContaPayload(body) {
  const errors = {};
  const empresaId = Number(body.empresaId);
  if (!empresaId) errors.empresaId = 'Selecione a empresa.';
  const contaBancariaId = Number(body.contaBancariaId);
  if (!contaBancariaId) errors.contaBancariaId = 'Selecione a conta bancária.';
  const valor = Number(body.valor);
  if (!Number.isFinite(valor)) errors.valor = 'Informe um valor numérico (pode ser negativo, se a conta estiver no vermelho).';
  const dataReferencia = String(body.dataReferencia || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia)) errors.dataReferencia = 'Informe a data de referência do saldo.';
  return {
    errors,
    data: {
      empresaId, contaBancariaId, valor: round2(valor),
      // 00:00:00 do dia de referência em BRT — ver semântica completa em
      // db/schema.sql, junto da tabela fluxo_caixa_saldo_inicial_conta:
      // representa o instante IMEDIATAMENTE ANTES do primeiro movimento
      // daquele dia (nunca ambíguo, nunca conta o dia de referência 2x).
      referenciaEm: /^\d{4}-\d{2}-\d{2}$/.test(dataReferencia) ? new Date(dataReferencia + 'T00:00:00.000-03:00') : null,
      observacao: String(body.observacao || '').trim() || null,
    },
  };
}

async function definirSaldoInicialConta(body) {
  const { errors, data } = validarSaldoInicialContaPayload(body);
  if (Object.keys(errors).length) return { errors };
  const { rows: contaRows } = await pool.query('SELECT id FROM contas_bancarias WHERE id=$1 AND empresa_id=$2', [data.contaBancariaId, data.empresaId]);
  if (!contaRows.length) return { errors: { contaBancariaId: 'Conta bancária não encontrada para esta empresa.' } };
  await pool.query(
    `INSERT INTO fluxo_caixa_saldo_inicial_conta (empresa_id, conta_bancaria_id, valor, referencia_em, observacao)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (conta_bancaria_id) DO UPDATE SET valor = EXCLUDED.valor, referencia_em = EXCLUDED.referencia_em, observacao = EXCLUDED.observacao, updated_at = now()`,
    [data.empresaId, data.contaBancariaId, data.valor, data.referenciaEm, data.observacao]
  );
  return { saldoInicial: await buscarSaldoInicialConta(data.contaBancariaId) };
}

// Saldo da CONTA no INÍCIO do dia `diaAlvo` (YYYY-MM-DD) — ou seja, já
// incluindo tudo que aconteceu ATÉ o dia anterior (o saldo "de abertura").
// Semântica do saldo inicial: representa o saldo IMEDIATAMENTE ANTES do
// primeiro movimento do dia de referência — por isso a soma abaixo começa
// EXATAMENTE no dia de referência (`data >= dataRef`), nunca no dia
// seguinte: o valor de `saldoInicialConta.valor` nunca inclui nenhum
// movimento daquele dia, então somar os movimentos a partir dele (inclusive)
// nunca conta nada duas vezes. Inclui TUDO, inclusive transferências
// internas — dinheiro que realmente saiu/entrou desta conta específica
// (transferência só é excluída dos INDICADORES OPERACIONAIS, nunca do
// saldo real de uma conta — ver realizadoPorDia).
async function saldoContaEm(contaBancariaId, saldoInicialConta, diaAlvo) {
  if (!saldoInicialConta) return null;
  const dataRef = diaBRT(saldoInicialConta.referenciaEm);
  if (diaAlvo <= dataRef) return round2(saldoInicialConta.valor);

  const diaAnterior = somarDiasData(diaAlvo, -1);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE -valor END), 0) AS total
     FROM extrato_movimentos WHERE conta_bancaria_id = $1 AND data BETWEEN $2 AND $3`,
    [contaBancariaId, dataRef, diaAnterior]
  );
  return round2(saldoInicialConta.valor + Number(rows[0].total));
}

// Saldo por conta + saldo consolidado da empresa no início de `diaAlvo`.
// NUNCA inventa: contas ativas sem saldo inicial configurado vêm com
// `saldo: null` individualmente, E o consolidado inteiro vem `null` (nunca
// soma parcial fingindo ser o total da empresa — pedido explícito do
// usuário, ponto 14). Mesmo assim, a lista por conta é sempre devolvida
// completa (mostra o que dá, nunca esconde as contas que JÁ têm saldo
// configurado só porque outra conta ainda não tem).
async function saldosPorContaEDaEmpresaEm(empresaId, diaAlvo) {
  const { rows: contas } = await pool.query(
    `SELECT cb.id AS conta_bancaria_id, cb.nome, si.valor, si.referencia_em, si.observacao, si.updated_at
     FROM contas_bancarias cb
     LEFT JOIN fluxo_caixa_saldo_inicial_conta si ON si.conta_bancaria_id = cb.id
     WHERE cb.empresa_id = $1 AND cb.ativa = TRUE
     ORDER BY cb.nome`,
    [empresaId]
  );

  const porConta = await Promise.all(contas.map(async (c) => {
    const saldoInicial = c.valor === null ? null : { valor: Number(c.valor), referenciaEm: c.referencia_em, observacao: c.observacao, atualizadoEm: c.updated_at };
    const saldo = saldoInicial ? await saldoContaEm(c.conta_bancaria_id, saldoInicial, diaAlvo) : null;
    return { contaBancariaId: c.conta_bancaria_id, nome: c.nome, saldoInicial, saldo };
  }));

  if (!porConta.length) return { valor: null, motivo: 'sem_conta_bancaria_cadastrada', porConta };
  const semSaldo = porConta.filter((c) => c.saldo === null);
  if (semSaldo.length) {
    return {
      valor: null,
      motivo: 'saldo_inicial_pendente_em_alguma_conta',
      contasSemSaldoInicial: semSaldo.map((c) => ({ id: c.contaBancariaId, nome: c.nome })),
      porConta,
    };
  }
  return { valor: round2(porConta.reduce((acc, c) => acc + c.saldo, 0)), motivo: null, porConta };
}

// ---------------- REALIZADO (a partir do extrato bancário — ETAPA 3) ----------------

// Soma diária do extrato bancário — fonte ÚNICA do REALIZADO. Quando
// `contaBancariaId` é passado, escopa a UMA conta (saldo por conta); sem
// ele, é a empresa inteira (todas as contas, consolidado). Quando
// `excluirTransferenciaInterna` é true, movimentos com
// `categoria = 'transferencia_interna'` saem da soma — usado nos
// indicadores operacionais (cards/gráfico/tabela: entradas/saídas
// REALIZADAS não podem inflar por causa de dinheiro que só mudou de conta
// própria, ponto 11 do pedido do usuário). NUNCA filtra por
// status_conciliacao — conciliado ou não, se aconteceu no banco, conta
// (ponto 7/10 do pedido do usuário).
async function realizadoPorDia({ empresaId, contaBancariaId, desde, ate, excluirTransferenciaInterna }) {
  const condicoes = ['empresa_id = $1', 'data BETWEEN $2 AND $3'];
  const params = [empresaId, desde, ate];
  if (contaBancariaId) { params.push(contaBancariaId); condicoes.push('conta_bancaria_id = $' + params.length); }
  if (excluirTransferenciaInterna) condicoes.push("(categoria IS NULL OR categoria <> 'transferencia_interna')");

  const { rows } = await pool.query(
    `SELECT data, tipo, valor FROM extrato_movimentos WHERE ${condicoes.join(' AND ')}`,
    params
  );

  const porDia = new Map();
  let entradasTotal = 0, saidasTotal = 0;
  for (const r of rows) {
    const dia = String(r.data).slice(0, 10);
    const v = Number(r.valor);
    const atual = porDia.get(dia) || { entradas: 0, saidas: 0 };
    if (r.tipo === 'entrada') { atual.entradas = round2(atual.entradas + v); entradasTotal = round2(entradasTotal + v); }
    else { atual.saidas = round2(atual.saidas + v); saidasTotal = round2(saidasTotal + v); }
    porDia.set(dia, atual);
  }
  return { porDia, entradasTotal, saidasTotal };
}

// Total de transferências internas já classificadas no período — card
// informativo separado (ponto 11), nunca somado nos indicadores acima.
async function transferenciasInternasNoPeriodo({ empresaId, contaBancariaId, desde, ate }) {
  const condicoes = ["empresa_id = $1", "data BETWEEN $2 AND $3", "categoria = 'transferencia_interna'"];
  const params = [empresaId, desde, ate];
  if (contaBancariaId) { params.push(contaBancariaId); condicoes.push('conta_bancaria_id = $' + params.length); }
  const { rows } = await pool.query(
    `SELECT tipo, COALESCE(SUM(valor),0) AS total FROM extrato_movimentos WHERE ${condicoes.join(' AND ')} GROUP BY tipo`,
    params
  );
  let entradas = 0, saidas = 0;
  for (const r of rows) { if (r.tipo === 'entrada') entradas = round2(Number(r.total)); else saidas = round2(Number(r.total)); }
  return { entradas, saidas };
}

// Classifica um par de movimentos (saída numa conta + entrada em outra da
// MESMA empresa) como transferência interna — sempre uma ação EXPLÍCITA do
// usuário (nunca automática só por valor/data batendo, pedido do ponto 12).
// Suporte de modelagem desta etapa; a tela de sugestão ainda não existe.
async function classificarComoTransferenciaInterna({ empresaId, movimentoOrigemId, movimentoDestinoId }) {
  const { rows } = await pool.query(
    `SELECT id, empresa_id, tipo FROM extrato_movimentos WHERE id = ANY($1::int[]) AND empresa_id = $2`,
    [[movimentoOrigemId, movimentoDestinoId], empresaId]
  );
  if (rows.length !== 2) return { errors: { geral: 'Os dois movimentos precisam existir e pertencer a esta empresa.' } };
  const origem = rows.find((r) => r.id === Number(movimentoOrigemId));
  const destino = rows.find((r) => r.id === Number(movimentoDestinoId));
  if (!origem || origem.tipo !== 'saida') return { errors: { movimentoOrigemId: 'O movimento de origem precisa ser uma saída.' } };
  if (!destino || destino.tipo !== 'entrada') return { errors: { movimentoDestinoId: 'O movimento de destino precisa ser uma entrada.' } };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE extrato_movimentos SET categoria='transferencia_interna', transferencia_par_id=$1 WHERE id=$2`, [destino.id, origem.id]);
    await client.query(`UPDATE extrato_movimentos SET categoria='transferencia_interna', transferencia_par_id=$1 WHERE id=$2`, [origem.id, destino.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { ok: true };
}

// ---------------- PREVISTO (contas_pagar/contas_receber pendentes — inalterado) ----------------

function somarPorDiaComDobraParaHoje(rows, campoData, hoje) {
  const mapa = new Map();
  for (const r of rows) {
    let dia = String(r[campoData]).slice(0, 10);
    if (dia < hoje) dia = hoje;
    mapa.set(dia, round2((mapa.get(dia) || 0) + Number(r.valor)));
  }
  return mapa;
}

// Ocorrências de despesa fixa ainda SEM conta a pagar gerada, dentro de
// [desde, ate] — a peça central da regra "nunca contar duas vezes" (ver
// comentário no topo do arquivo).
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
  const jaGeradasSet = new Set(jaGeradas.map((r) => r.despesa_fixa_id + '|' + String(r.vencimento).slice(0, 10)));

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

// ---------------- Fluxo de Caixa completo (REALIZADO + PREVISTO) ----------------

// `contaBancariaId` opcional: sem ele, é o fluxo CONSOLIDADO da empresa
// (todas as contas ativas) — o que a tela principal usa. Com ele, escopa o
// REALIZADO e o saldo a UMA conta específica (ATENÇÃO — limitação
// conhecida: contas_pagar/contas_receber NÃO têm coluna conta_bancaria_id
// hoje, então o PREVISTO — entradasPrevistas/saidasPrevistas/contasVencidas
// — continua sempre em nível de EMPRESA mesmo quando contaBancariaId é
// passado; só o REALIZADO e o saldo são realmente por conta).
async function gerarFluxoDeCaixa({ empresaId, periodoChave, desde: desdeQuery, ate: ateQuery, contaBancariaId }) {
  const periodo = calcularPeriodoFluxoCaixa(periodoChave, { desde: desdeQuery, ate: ateQuery });
  const { desde, ate } = periodo;
  const hoje = hojeBRT();

  const [
    pendentesPagar,
    pendentesReceber,
    despesasAtivas,
    resumoPagar,
    resumoReceber,
    realizado,
    transferencias,
  ] = await Promise.all([
    pool.query(`SELECT vencimento, valor FROM contas_pagar WHERE empresa_id=$1 AND status='pendente'`, [empresaId]).then((r) => r.rows),
    pool.query(`SELECT data_prevista, valor FROM contas_receber WHERE empresa_id=$1 AND status='a_receber'`, [empresaId]).then((r) => r.rows),
    despesasFixas.listarDespesasFixas({ empresaId, ativo: true }),
    contasPagar.resumoContasPagar({ empresaId, desde, ate }),
    contasReceber.resumoContasReceber({ empresaId, desde, ate }),
    realizadoPorDia({ empresaId, contaBancariaId, desde, ate, excluirTransferenciaInterna: true }),
    transferenciasInternasNoPeriodo({ empresaId, contaBancariaId, desde, ate }),
  ]);

  const { porDia: despesasFixasPorDia, total: despesasFixasPrevistasTotal } = await calcularDespesasFixasPrevistasPorDia({ empresaId, desde, ate, despesasAtivas, hoje });

  // Recebimentos de marketplace — ETAPA 3: só o PREVISTO entra aqui. O
  // REALIZADO de um recebimento que já caiu no banco vem de
  // extrato_movimentos (acima); nunca mais somado de novo aqui — é
  // exatamente essa duplicação (previsto + realizado) que o usuário pediu
  // pra nunca acontecer (TESTE 12).
  const desdeInstant = inicioDoDiaBRTDeString(desde);
  const ateInstant = inicioDoDiaBRTDeString(somarDiasData(ate, 1));
  const recebimentosMlDoPeriodo = await listarRecebimentosMl({ empresaId, desde: desdeInstant, ate: ateInstant });
  const recebimentosMlPrevisto = recebimentosMlDoPeriodo.filter((r) => r.status !== 'recebido');
  let recebimentosMlPrevistoTotal = 0;
  for (const r of recebimentosMlPrevisto) {
    if (r.valorLiquidoEsperado !== null) recebimentosMlPrevistoTotal = round2(recebimentosMlPrevistoTotal + r.valorLiquidoEsperado);
  }

  const mapaPagarProjetado = somarPorDiaComDobraParaHoje(pendentesPagar, 'vencimento', hoje);
  const mapaReceberProjetado = somarPorDiaComDobraParaHoje(pendentesReceber, 'data_prevista', hoje);

  // Saldo: de UMA conta (contaBancariaId) ou consolidado da empresa.
  async function saldoEm(diaAlvo) {
    if (contaBancariaId) {
      const saldoInicialConta = await buscarSaldoInicialConta(contaBancariaId);
      const valor = await saldoContaEm(contaBancariaId, saldoInicialConta, diaAlvo);
      return valor === null ? { valor: null, motivo: 'sem_saldo_inicial_informado' } : { valor, motivo: null };
    }
    const consolidado = await saldosPorContaEDaEmpresaEm(empresaId, diaAlvo);
    return consolidado.valor === null
      ? { valor: null, motivo: consolidado.motivo, contasSemSaldoInicial: consolidado.contasSemSaldoInicial || [], porConta: consolidado.porConta }
      : { valor: consolidado.valor, motivo: null, porConta: consolidado.porConta };
  }

  const saldoAberturaPeriodo = await saldoEm(desde);
  const saldoAtualObj = await saldoEm(somarDiasData(hoje, 1)); // saldo "agora" = abertura de amanhã = fecha hoje incluso

  const dias = [];
  let cursor = desde;
  let acumulado = saldoAberturaPeriodo.valor; // pode ser null (sem saldo informado)
  let entradasPrevistasTotal = 0, saidasPrevistasTotal = 0;

  while (cursor <= ate) {
    const passado = cursor < hoje;
    const diaRealizado = realizado.porDia.get(cursor) || { entradas: 0, saidas: 0 };
    const entradaRealizada = diaRealizado.entradas;
    const saidaRealizada = diaRealizado.saidas;
    const entradaProjetada = passado ? 0 : round2(mapaReceberProjetado.get(cursor) || 0);
    const saidaProjetadaContas = passado ? 0 : round2(mapaPagarProjetado.get(cursor) || 0);
    const saidaProjetadaDespesasFixas = passado ? 0 : round2(despesasFixasPorDia.get(cursor) || 0);
    const saidaProjetada = round2(saidaProjetadaContas + saidaProjetadaDespesasFixas);

    entradasPrevistasTotal = round2(entradasPrevistasTotal + entradaProjetada);
    saidasPrevistasTotal = round2(saidasPrevistasTotal + saidaProjetada);

    if (acumulado !== null) {
      acumulado = round2(acumulado + entradaRealizada + entradaProjetada - saidaRealizada - saidaProjetada);
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

  const saldoProjetadoValor = dias.length ? dias[dias.length - 1].saldoAcumulado : acumulado;
  const saldoProjetadoObj = saldoProjetadoValor === null || saldoProjetadoValor === undefined
    ? { valor: null, motivo: saldoAtualObj.motivo || 'sem_saldo_inicial_informado' }
    : { valor: saldoProjetadoValor, motivo: null };

  return {
    periodo: { chave: periodo.chave, label: periodo.label, desde, ate },
    contaBancariaId: contaBancariaId || null,
    // Só no consolidado (sem contaBancariaId): lista por conta, pra tela
    // mostrar "Saldo por conta" e permitir configurar/editar cada uma.
    saldosPorConta: contaBancariaId ? null : (saldoAtualObj.porConta || []),
    cards: {
      saldoAtual: saldoAtualObj,
      entradasRealizadas: realizado.entradasTotal,
      saidasRealizadas: realizado.saidasTotal,
      resultadoRealizado: round2(realizado.entradasTotal - realizado.saidasTotal),
      entradasPrevistas: round2(entradasPrevistasTotal),
      saidasPrevistas: round2(saidasPrevistasTotal),
      saldoProjetado: saldoProjetadoObj,
      contasVencidas: round2(resumoPagar.vencidas + resumoReceber.atrasado),
      transferenciasInternas: transferencias,
    },
    resumoFormula: {
      // Fórmula pedida (ponto 16): SALDO PROJETADO = SALDO ATUAL +
      // ENTRADAS PREVISTAS − SAÍDAS PREVISTAS. "Contas a receber"/"Contas a
      // pagar" aqui são só o que está PENDENTE dentro do período mostrado —
      // nunca o saldo em aberto "pra sempre" (isso já é mostrado nas telas
      // de Contas a Pagar/Receber).
      saldoInicialOuAtual: saldoAtualObj,
      contasAReceber: round2(entradasPrevistasTotal),
      recebimentosPrevistosMarketplaces: recebimentosMlPrevistoTotal,
      contasAPagar: round2(saidasPrevistasTotal - despesasFixasPrevistasTotal),
      despesasFixasPrevistas: despesasFixasPrevistasTotal,
      saldoProjetado: saldoProjetadoObj,
    },
    realizadoNoPeriodo: { entradas: realizado.entradasTotal, saidas: realizado.saidasTotal },
    recebimentosMarketplaces: {
      // Só PREVISTO a partir de agora (ver comentário acima) — nunca soma
      // de novo o que já virou realizado via extrato_movimentos.
      total: recebimentosMlPrevistoTotal,
      quantidade: recebimentosMlPrevisto.length,
      semDataDeLiberacao: true,
    },
    serieDiaria: dias,
  };
}

module.exports = {
  PERIODOS_VALIDOS,
  calcularPeriodoFluxoCaixa,
  // Legado (empresa) — preservado, nunca mais usado por gerarFluxoDeCaixa.
  buscarSaldoInicial,
  definirSaldoInicial,
  // Por conta (ETAPA 3) — fonte real do saldo a partir de agora.
  buscarSaldoInicialConta,
  definirSaldoInicialConta,
  saldoContaEm,
  saldosPorContaEDaEmpresaEm,
  realizadoPorDia,
  transferenciasInternasNoPeriodo,
  classificarComoTransferenciaInterna,
  gerarFluxoDeCaixa,
  calcularDespesasFixasPrevistasPorDia,
};
