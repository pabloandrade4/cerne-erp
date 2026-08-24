// Contas a Receber — lançamento manual, por empresa. Ativado em 24/08/2026
// (ver docs/04-alteracoes.md e docs/02-decisoes.md). Simétrico a
// lib/contasPagar.js — mesma filosofia: "atrasado" é sempre calculado
// (nunca gravado), e um lançamento já RECEBIDO ou CANCELADO não pode mais
// ser editado/excluído (registro histórico).
const pool = require('../db/pool');
const { diaBRT } = require('./periodo');

const STATUS_VALIDOS = ['a_receber', 'recebido', 'cancelado'];
const ORIGENS_SUGERIDAS = [
  'Venda direta', 'Mercado Livre', 'Shopee', 'Reembolso', 'Empréstimo',
  'Aporte de sócio', 'Outros',
];

function hojeBRT() {
  return diaBRT(new Date());
}

function round2(n) { return Math.round(n * 100) / 100; }

function serialize(row, hoje) {
  const h = hoje || hojeBRT();
  const previstaStr = row.data_prevista ? String(row.data_prevista).slice(0, 10) : null;
  const atrasado = row.status === 'a_receber' && previstaStr !== null && previstaStr < h;
  return {
    id: row.id,
    empresaId: row.empresa_id,
    descricao: row.descricao,
    origem: row.origem,
    valor: Number(row.valor),
    dataPrevista: previstaStr,
    dataRecebida: row.data_recebida ? String(row.data_recebida).slice(0, 10) : null,
    statusBase: row.status,
    status: atrasado ? 'atrasado' : row.status,
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

  if (body.origem !== undefined) {
    const origem = String(body.origem || '').trim();
    if (origem.length > 100) errors.origem = 'Origem muito longa (máx. 100 caracteres).';
    else out.origem = origem || null;
  }

  if (!partial || body.valor !== undefined) {
    const valor = Number(body.valor);
    if (!Number.isFinite(valor) || valor <= 0) errors.valor = 'Informe um valor maior que zero.';
    else out.valor = round2(valor);
  }

  if (!partial || body.dataPrevista !== undefined) {
    const dataPrevista = String(body.dataPrevista || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPrevista)) errors.dataPrevista = 'Informe a data prevista.';
    else out.dataPrevista = dataPrevista;
  }

  if (body.observacao !== undefined) {
    out.observacao = String(body.observacao || '').trim() || null;
  }

  return { errors, data: out };
}

async function listarContasReceber({ empresaId, desde, ate, status, search }) {
  const conditions = ['empresa_id = $1', 'data_prevista >= $2', 'data_prevista <= $3'];
  const params = [empresaId, desde, ate];
  if (search && search.trim()) {
    params.push('%' + search.trim() + '%');
    const idx = params.length;
    conditions.push('(descricao ILIKE $' + idx + ' OR origem ILIKE $' + idx + ')');
  }

  const { rows } = await pool.query(
    `SELECT * FROM contas_receber WHERE ${conditions.join(' AND ')} ORDER BY data_prevista ASC, id DESC`,
    params
  );

  const hoje = hojeBRT();
  let contas = rows.map((r) => serialize(r, hoje));
  if (status) contas = contas.filter((c) => c.status === status);
  return contas;
}

// "Total a receber", "previsto para hoje" e "atrasado" são o saldo em
// aberto da empresa, independente do período selecionado no header (mesma
// decisão de contas_pagar — ver docs/02-decisoes.md). Só "recebido no
// período" usa o período selecionado (data_recebida dentro de [desde, ate]).
async function resumoContasReceber({ empresaId, desde, ate }) {
  const hoje = hojeBRT();
  const { rows: abertos } = await pool.query(
    `SELECT data_prevista, valor FROM contas_receber WHERE empresa_id = $1 AND status = 'a_receber'`,
    [empresaId]
  );
  let totalAReceber = 0, previstoHoje = 0, atrasado = 0;
  for (const r of abertos) {
    const v = Number(r.valor);
    totalAReceber += v;
    const prev = String(r.data_prevista).slice(0, 10);
    if (prev === hoje) previstoHoje += v;
    else if (prev < hoje) atrasado += v;
  }

  const { rows: recebidos } = await pool.query(
    `SELECT COALESCE(SUM(valor), 0) AS total FROM contas_receber
     WHERE empresa_id = $1 AND status = 'recebido' AND data_recebida >= $2 AND data_recebida <= $3`,
    [empresaId, desde, ate]
  );

  return {
    totalAReceber: round2(totalAReceber),
    previstoHoje: round2(previstoHoje),
    atrasado: round2(atrasado),
    recebidoNoPeriodo: round2(Number(recebidos[0].total)),
  };
}

async function criarContaReceber(body) {
  const { errors, data } = validatePayload(body);
  if (Object.keys(errors).length) return { errors };

  const { rows } = await pool.query(
    `INSERT INTO contas_receber (empresa_id, descricao, origem, valor, data_prevista, observacao, status)
     VALUES ($1,$2,$3,$4,$5,$6,'a_receber')
     RETURNING *`,
    [data.empresaId, data.descricao, data.origem || null, data.valor, data.dataPrevista, data.observacao || null]
  );
  return { conta: serialize(rows[0]) };
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM contas_receber WHERE id = $1', [id]);
  return rows[0] || null;
}

async function atualizarContaReceber(id, body) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status !== 'a_receber') {
    return { errors: { status: 'Só é possível editar um lançamento a receber — recebidos ou cancelados não podem mais ser alterados.' } };
  }

  const { errors, data } = validatePayload(body, { partial: true });
  if (Object.keys(errors).length) return { errors };
  if (!Object.keys(data).length) return { errors: { geral: 'Nada para atualizar.' } };

  const colMap = { descricao: 'descricao', origem: 'origem', valor: 'valor', dataPrevista: 'data_prevista', observacao: 'observacao' };
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(colMap)) {
    if (data[key] !== undefined) { fields.push(`${col} = $${i++}`); values.push(data[key]); }
  }
  fields.push('updated_at = now()');
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE contas_receber SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return { conta: serialize(rows[0]) };
}

async function marcarComoRecebido(id, dataRecebida) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'cancelado') return { errors: { geral: 'Não é possível marcar como recebido um lançamento cancelado.' } };
  if (atual.status === 'recebido') return { errors: { geral: 'Este lançamento já está marcado como recebido.' } };

  const data = dataRecebida && /^\d{4}-\d{2}-\d{2}$/.test(dataRecebida) ? dataRecebida : hojeBRT();
  const { rows } = await pool.query(
    `UPDATE contas_receber SET status = 'recebido', data_recebida = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [data, id]
  );
  return { conta: serialize(rows[0]) };
}

async function cancelarContaReceber(id) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'recebido') return { errors: { geral: 'Não é possível cancelar um lançamento já recebido.' } };
  if (atual.status === 'cancelado') return { errors: { geral: 'Este lançamento já está cancelado.' } };

  const { rows } = await pool.query(
    `UPDATE contas_receber SET status = 'cancelado', updated_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  return { conta: serialize(rows[0]) };
}

async function excluirContaReceber(id) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'recebido') return { errors: { geral: 'Não é possível excluir um lançamento já recebido — cancele um novo lançamento em vez de apagar o histórico.' } };

  await pool.query('DELETE FROM contas_receber WHERE id = $1', [id]);
  return { ok: true };
}

module.exports = {
  STATUS_VALIDOS,
  ORIGENS_SUGERIDAS,
  serialize,
  hojeBRT,
  listarContasReceber,
  resumoContasReceber,
  criarContaReceber,
  buscarPorId,
  atualizarContaReceber,
  marcarComoRecebido,
  cancelarContaReceber,
  excluirContaReceber,
};
