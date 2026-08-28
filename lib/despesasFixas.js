// Despesas Fixas — cadastro de despesas recorrentes da empresa (aluguel,
// salários, pró-labore, sistemas, contador, energia, internet etc.),
// ativado em 25/08/2026 (ver docs/04-alteracoes.md e docs/02-decisoes.md).
//
// Uma despesa fixa NÃO é, ela mesma, um lançamento financeiro — é só o
// MOLDE de uma despesa que se repete. Quem representa dinheiro de verdade
// continua sendo contas_pagar (lib/contasPagar.js, intocado): a cada ciclo
// (lib/despesasFixasScheduler.js) este módulo GERA a conta a pagar
// correspondente à ocorrência que "chegou" (ver gerarContasPagarAutomaticas
// abaixo), gravando o vínculo em contas_pagar.despesa_fixa_id. Editar uma
// despesa fixa depois nunca altera contas já geradas — só afeta as
// PRÓXIMAS ocorrências (mesma filosofia de "fato financeiro não muda
// sozinho" já usada em contas_pagar/contas_receber/compras).
const pool = require('../db/pool');
const { diaBRT, dataCalendarioISO } = require('./periodo');

const FREQUENCIAS_VALIDAS = ['mensal', 'semanal', 'anual'];
const CATEGORIAS_SUGERIDAS = [
  'Aluguel', 'Salários', 'Pró-labore', 'Sistemas e assinaturas',
  'Contador', 'Energia', 'Internet e telefonia', 'Impostos e taxas',
  'Outras despesas recorrentes',
];

function hojeBRT() {
  return diaBRT(new Date());
}

function round2(n) { return Math.round(n * 100) / 100; }
function pad2(n) { return String(n).padStart(2, '0'); }

// Último dia (1-31) de um mês de calendário — usado pra "dia 31" cair no
// último dia de fevereiro/abril/etc. em vez de estourar a data, igual
// qualquer sistema de cobrança recorrente de verdade.
function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

function normalizarDiaMes(ano, mes, dia) {
  return Math.min(dia, ultimoDiaDoMes(ano, mes));
}

// Dia da semana ISO (1=segunda...7=domingo) de uma data 'YYYY-MM-DD' — usado
// só pra despesas semanais (ver comentário em db/schema.sql).
function diaDaSemanaISO(dataStr) {
  const [y, m, d] = dataStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=domingo...6=sábado
  return dow === 0 ? 7 : dow;
}

function somarDiasData(dataStr, dias) {
  const [y, m, d] = dataStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}

function serialize(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    descricao: row.descricao,
    categoria: row.categoria,
    valor: Number(row.valor),
    frequencia: row.frequencia,
    diaVencimento: row.dia_vencimento,
    dataInicio: dataCalendarioISO(row.data_inicio),
    dataFim: dataCalendarioISO(row.data_fim),
    ativo: row.ativo,
    observacao: row.observacao,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

function validatePayload(body, { partial = false } = {}) {
  const errors = {};
  const out = {};

  if (!partial) {
    const empresaId = Number(body.empresaId);
    if (!empresaId) errors.empresaId = 'Selecione a empresa.';
    else out.empresaId = empresaId;
  }

  if (!partial || body.descricao !== undefined) {
    const descricao = String(body.descricao || '').trim();
    if (!descricao) errors.descricao = 'Informe a descrição.';
    else if (descricao.length > 200) errors.descricao = 'Descrição muito longa (máx. 200 caracteres).';
    else out.descricao = descricao;
  }

  if (body.categoria !== undefined) {
    const categoria = String(body.categoria || '').trim();
    if (categoria.length > 100) errors.categoria = 'Categoria muito longa (máx. 100 caracteres).';
    else out.categoria = categoria || null;
  }

  if (!partial || body.valor !== undefined) {
    const valor = Number(body.valor);
    if (!Number.isFinite(valor) || valor <= 0) errors.valor = 'Informe um valor maior que zero.';
    else out.valor = round2(valor);
  }

  let frequencia = null;
  if (!partial || body.frequencia !== undefined) {
    frequencia = String(body.frequencia || '').trim();
    if (!FREQUENCIAS_VALIDAS.includes(frequencia)) errors.frequencia = 'Informe uma frequência válida (mensal, semanal ou anual).';
    else out.frequencia = frequencia;
  }

  if (!partial || body.dataInicio !== undefined) {
    const dataInicio = String(body.dataInicio || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInicio)) errors.dataInicio = 'Informe a data de início.';
    else out.dataInicio = dataInicio;
  }

  if (body.dataFim !== undefined) {
    const dataFim = String(body.dataFim || '').trim();
    if (!dataFim) out.dataFim = null;
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(dataFim)) errors.dataFim = 'Data de término inválida.';
    else out.dataFim = dataFim;
  }

  if (out.dataInicio && out.dataFim && out.dataFim < out.dataInicio) {
    errors.dataFim = 'A data de término não pode ser antes da data de início.';
  }

  // dia_vencimento: significado depende da frequência (ver comentário em
  // db/schema.sql). Pra semanal, é SEMPRE derivado do dia da semana de
  // data_inicio (nunca aceito do formulário) — nunca fica inconsistente com
  // a própria data em que a despesa realmente começa a se repetir.
  if (!partial || body.diaVencimento !== undefined || frequencia === 'semanal') {
    if (frequencia === 'semanal' && out.dataInicio) {
      out.diaVencimento = diaDaSemanaISO(out.dataInicio);
    } else if (frequencia === 'mensal' || frequencia === 'anual') {
      const dia = Number(body.diaVencimento);
      if (!Number.isInteger(dia) || dia < 1 || dia > 31) errors.diaVencimento = 'Informe um dia do mês entre 1 e 31.';
      else out.diaVencimento = dia;
    } else if (!partial) {
      errors.diaVencimento = 'Informe o dia de vencimento.';
    }
  }

  if (body.observacao !== undefined) {
    out.observacao = String(body.observacao || '').trim() || null;
  }

  if (body.ativo !== undefined) {
    out.ativo = body.ativo === true || body.ativo === 'true' || body.ativo === '1';
  } else if (!partial) {
    out.ativo = true; // nova despesa fixa nasce ativa por padrão, salvo indicação contrária
  }

  return { errors, data: out };
}

async function listarDespesasFixas({ empresaId, ativo }) {
  const conditions = ['empresa_id = $1'];
  const params = [empresaId];
  if (ativo !== undefined && ativo !== null && ativo !== '') {
    params.push(ativo === true || ativo === 'true' || ativo === '1');
    conditions.push(`ativo = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM despesas_fixas WHERE ${conditions.join(' AND ')} ORDER BY ativo DESC, dia_vencimento ASC, descricao ASC`,
    params
  );
  return rows.map(serialize);
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM despesas_fixas WHERE id = $1', [id]);
  return rows[0] || null;
}

async function criarDespesaFixa(body) {
  const { errors, data } = validatePayload(body);
  if (Object.keys(errors).length) return { errors };

  const { rows } = await pool.query(
    `INSERT INTO despesas_fixas (empresa_id, descricao, categoria, valor, frequencia, dia_vencimento, data_inicio, data_fim, ativo, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [data.empresaId, data.descricao, data.categoria || null, data.valor, data.frequencia, data.diaVencimento,
      data.dataInicio, data.dataFim || null, data.ativo, data.observacao || null]
  );
  return { despesa: serialize(rows[0]) };
}

async function atualizarDespesaFixa(id, body) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };

  // Pra validar corretamente "semanal deriva dia_vencimento de data_inicio"
  // numa edição PARCIAL, sempre considera a frequência/data_inicio já
  // salvas quando o corpo da requisição não as está trocando.
  const bodyComContexto = {
    frequencia: body.frequencia !== undefined ? body.frequencia : atual.frequencia,
    dataInicio: body.dataInicio !== undefined ? body.dataInicio : dataCalendarioISO(atual.data_inicio),
    ...body,
  };

  const { errors, data } = validatePayload(bodyComContexto, { partial: true });
  if (Object.keys(errors).length) return { errors };
  if (!Object.keys(data).length) return { errors: { geral: 'Nada para atualizar.' } };

  const colMap = {
    descricao: 'descricao', categoria: 'categoria', valor: 'valor', frequencia: 'frequencia',
    diaVencimento: 'dia_vencimento', dataInicio: 'data_inicio', dataFim: 'data_fim',
    ativo: 'ativo', observacao: 'observacao',
  };
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(colMap)) {
    if (data[key] !== undefined) { fields.push(`${col} = $${i++}`); values.push(data[key]); }
  }
  fields.push('updated_at = now()');
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE despesas_fixas SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return { despesa: serialize(rows[0]) };
}

async function definirAtivo(id, ativo) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  const { rows } = await pool.query(
    `UPDATE despesas_fixas SET ativo = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [!!ativo, id]
  );
  return { despesa: serialize(rows[0]) };
}

// Só permite excluir uma despesa fixa que nunca gerou nenhuma conta a pagar
// — mesma razão de excluirContaPagar (nunca apagar o que já virou fato
// financeiro; se já gerou histórico, o caminho é desativar, não excluir).
async function excluirDespesaFixa(id) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  const { rows: geradas } = await pool.query('SELECT 1 FROM contas_pagar WHERE despesa_fixa_id = $1 LIMIT 1', [id]);
  if (geradas.length) {
    return { errors: { geral: 'Esta despesa fixa já gerou contas a pagar — desative em vez de excluir, para não perder o histórico.' } };
  }
  await pool.query('DELETE FROM despesas_fixas WHERE id = $1', [id]);
  return { ok: true };
}

// ---------------------------------------------------------------------
// Geração automática de Contas a Pagar a partir das despesas fixas ativas
// ---------------------------------------------------------------------

// Datas (YYYY-MM-DD) de vencimento de UMA despesa fixa dentro de
// [desde, ate], já recortadas por data_inicio/data_fim da própria despesa.
// Pura (sem banco) — só matemática de calendário, testável isoladamente.
function ocorrenciasNoIntervalo(despesa, desde, ate) {
  const inicioEfetivo = despesa.dataInicio > desde ? despesa.dataInicio : desde;
  const fimEfetivo = despesa.dataFim && despesa.dataFim < ate ? despesa.dataFim : ate;
  if (inicioEfetivo > fimEfetivo) return [];

  if (despesa.frequencia === 'semanal') {
    // Sempre de 7 em 7 dias a partir de data_inicio (nunca um cálculo de
    // "dia da semana" separado — ver comentário em db/schema.sql).
    const ocorrencias = [];
    let cursor = despesa.dataInicio;
    while (cursor < inicioEfetivo) cursor = somarDiasData(cursor, 7);
    while (cursor <= fimEfetivo) {
      if (cursor >= inicioEfetivo) ocorrencias.push(cursor);
      cursor = somarDiasData(cursor, 7);
    }
    return ocorrencias;
  }

  // mensal/anual: percorre cada mês que toca o intervalo [desde, ate] e
  // calcula a data candidata (clamp pro último dia do mês); anual só conta
  // o mês em que data_inicio caiu.
  const mesAnual = despesa.frequencia === 'anual' ? Number(despesa.dataInicio.slice(5, 7)) : null;
  const [ay0, am0] = desde.split('-').map(Number);
  const [ay1, am1] = ate.split('-').map(Number);
  const ocorrencias = [];
  let ano = ay0, mes = am0;
  while (ano < ay1 || (ano === ay1 && mes <= am1)) {
    if (mesAnual === null || mes === mesAnual) {
      const dia = normalizarDiaMes(ano, mes, despesa.diaVencimento);
      const dataStr = `${ano}-${pad2(mes)}-${pad2(dia)}`;
      if (dataStr >= inicioEfetivo && dataStr <= fimEfetivo) ocorrencias.push(dataStr);
    }
    mes++; if (mes > 12) { mes = 1; ano++; }
  }
  return ocorrencias;
}

// Último dia do mês corrente (BRT) — horizonte padrão da geração
// automática: "quando chegar o novo período" é interpretado como "o mês já
// começou", não "o dia exato do vencimento" — dá tempo do usuário ver a
// conta a pagar em Contas a Pagar e se planejar antes do vencimento chegar
// (mesmo raciocínio vale pra despesas semanais/anuais: todas as ocorrências
// que caem dentro do mês corrente já são geradas de uma vez).
function fimDoMesCorrenteBRT() {
  const hoje = hojeBRT();
  const [y, m] = hoje.split('-').map(Number);
  return `${y}-${pad2(m)}-${pad2(ultimoDiaDoMes(y, m))}`;
}

// Gera (se ainda não existirem) as contas a pagar de UMA despesa fixa, do
// início dela até `horizonteAte`. A não-duplicação é garantida no banco
// (índice único parcial em contas_pagar, ver db/schema.sql) — mesmo que
// esta função rode 2x seguidas (ou em paralelo), o ON CONFLICT nunca deixa
// inserir a mesma (despesa_fixa_id, vencimento) duas vezes.
async function gerarContasPagarParaDespesa(despesa, horizonteAte) {
  const ocorrencias = ocorrenciasNoIntervalo(despesa, despesa.dataInicio, horizonteAte);
  let geradas = 0;
  for (const vencimento of ocorrencias) {
    // `RETURNING id` (em vez de só olhar rowCount) é o jeito confiável de
    // saber se o INSERT realmente inseriu ou se o ON CONFLICT descartou:
    // com ON CONFLICT ... DO NOTHING, uma linha descartada por conflito
    // nunca aparece em RETURNING — 0 linhas devolvidas = já existia.
    const { rows } = await pool.query(
      `INSERT INTO contas_pagar (empresa_id, descricao, categoria, valor, vencimento, observacao, status, despesa_fixa_id)
       VALUES ($1,$2,$3,$4,$5,$6,'pendente',$7)
       ON CONFLICT (despesa_fixa_id, vencimento) WHERE despesa_fixa_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [despesa.empresaId, despesa.descricao, despesa.categoria, despesa.valor, vencimento,
        'Gerado automaticamente pela despesa fixa recorrente.', despesa.id]
    );
    if (rows.length) geradas++;
  }
  return geradas;
}

// Ponto de entrada do ciclo (chamado pelo scheduler em background e pelo
// botão "Gerar agora" da tela) — gera as contas a pagar de todas as
// despesas fixas ATIVAS (empresaId opcional: quando ausente, roda pra
// todas as empresas, igual sincronizarTodasAsContasAds).
async function gerarContasPagarAutomaticas({ empresaId } = {}) {
  const despesas = await listarDespesasFixas({ empresaId, ativo: true });
  const horizonte = fimDoMesCorrenteBRT();
  let totalGeradas = 0;
  const detalhes = [];
  for (const despesa of despesas) {
    const geradas = await gerarContasPagarParaDespesa(despesa, horizonte);
    totalGeradas += geradas;
    if (geradas) detalhes.push({ despesaFixaId: despesa.id, descricao: despesa.descricao, geradas });
  }
  return { totalGeradas, horizonte, detalhes };
}

module.exports = {
  FREQUENCIAS_VALIDAS,
  CATEGORIAS_SUGERIDAS,
  hojeBRT,
  serialize,
  listarDespesasFixas,
  buscarPorId,
  criarDespesaFixa,
  atualizarDespesaFixa,
  definirAtivo,
  excluirDespesaFixa,
  ocorrenciasNoIntervalo,
  fimDoMesCorrenteBRT,
  gerarContasPagarParaDespesa,
  gerarContasPagarAutomaticas,
  diaDaSemanaISO,
  normalizarDiaMes,
  ultimoDiaDoMes,
};
