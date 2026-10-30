// Contas a Receber — lançamento manual, por empresa. Ativado em 24/08/2026
// (ver docs/04-alteracoes.md e docs/02-decisoes.md). Simétrico a
// lib/contasPagar.js — mesma filosofia: "atrasado" é sempre calculado
// (nunca gravado), e um lançamento já RECEBIDO ou CANCELADO não pode mais
// ser editado/excluído (registro histórico).
const pool = require('../db/pool');
const { diaBRT, dataCalendarioISO } = require('./periodo');

const STATUS_VALIDOS = ['a_receber', 'recebido', 'cancelado'];
const ORIGENS_SUGERIDAS = [
  'Venda direta', 'Mercado Livre', 'Shopee', 'Reembolso', 'Empréstimo',
  'Aporte de sócio', 'Outros',
];

function hojeBRT() {
  return diaBRT(new Date());
}

function round2(n) { return Math.round(n * 100) / 100; }

// Fase 2: "todas" = visão das duas empresas juntas (só leitura).
function ehTodas(empresaId) {
  return String(empresaId) === 'todas';
}

function serialize(row, hoje) {
  const h = hoje || hojeBRT();
  const previstaStr = dataCalendarioISO(row.data_prevista);
  const atrasado = row.status === 'a_receber' && previstaStr !== null && previstaStr < h;
  return {
    id: row.id,
    empresaId: row.empresa_id,
    empresaNome: row.empresa_nome || null,
    descricao: row.descricao,
    origem: row.origem,
    valor: Number(row.valor),
    dataPrevista: previstaStr,
    dataRecebida: dataCalendarioISO(row.data_recebida),
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
  const conditions = [];
  const params = [];
  if (!ehTodas(empresaId)) { params.push(empresaId); conditions.push('cr.empresa_id = $' + params.length); }
  // Já recebidas só aparecem se recebidas dentro do período; a receber/
  // atrasadas/canceladas aparecem sempre (saldo em aberto, igual a Pagar).
  params.push(desde, ate);
  conditions.push("(cr.status != 'recebido' OR (cr.data_recebida >= $" + (params.length - 1) + ' AND cr.data_recebida <= $' + params.length + '))');
  if (search && search.trim()) {
    params.push('%' + search.trim() + '%');
    const idx = params.length;
    conditions.push('(cr.descricao ILIKE $' + idx + ' OR cr.origem ILIKE $' + idx + ')');
  }

  const { rows } = await pool.query(
    `SELECT cr.*, COALESCE(e.nome_fantasia, e.razao_social) AS empresa_nome FROM contas_receber cr LEFT JOIN empresas e ON e.id = cr.empresa_id
     WHERE ${conditions.join(' AND ')} ORDER BY cr.data_prevista ASC, cr.id DESC`,
    params
  );

  const hoje = hojeBRT();
  let contas = rows.map((r) => serialize(r, hoje));
  if (status) contas = contas.filter((c) => c.status === status);
  return contas;
}

// Mesma lógica de contasPagar.js (somarDiasData) — deliberadamente
// duplicada aqui em vez de compartilhada, pra manter os dois módulos
// independentes um do outro (mesmo padrão já usado no resto do arquivo).
function somarDiasData(dataStr, dias) {
  const [y, m, d] = dataStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  const p = (n) => String(n).padStart(2, '0');
  return dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1) + '-' + p(dt.getUTCDate());
}

// "Total a receber", "previsto para hoje" e "atrasado" são o saldo em
// aberto da empresa, independente do período selecionado no header (mesma
// decisão de contas_pagar — ver docs/02-decisoes.md). Só "recebido no
// período" usa o período selecionado (data_recebida dentro de [desde, ate]).
//
// "previstoProximos7Dias" — adicionado pra IA Gestora (mesma razão de
// contasPagar.js/vencendoProximos7Dias): recorte do saldo em aberto entre
// amanhã e 6 dias à frente, nunca um cálculo novo.
async function resumoContasReceber({ empresaId, desde, ate }) {
  const hoje = hojeBRT();
  const limite7dias = somarDiasData(hoje, 7);
  const todas = ehTodas(empresaId);
  const { rows: abertos } = await pool.query(
    `SELECT data_prevista, valor FROM contas_receber WHERE status = 'a_receber'` + (todas ? '' : ' AND empresa_id = $1'),
    todas ? [] : [empresaId]
  );
  let totalAReceber = 0, previstoHoje = 0, atrasado = 0, previstoProximos7Dias = 0;
  for (const r of abertos) {
    const v = Number(r.valor);
    totalAReceber += v;
    const prev = dataCalendarioISO(r.data_prevista);
    if (prev === hoje) previstoHoje += v;
    else if (prev < hoje) atrasado += v;
    else if (prev <= limite7dias) previstoProximos7Dias += v;
  }

  const { rows: recebidos } = await pool.query(
    `SELECT COALESCE(SUM(valor), 0) AS total FROM contas_receber
     WHERE status = 'recebido' AND data_recebida >= $1 AND data_recebida <= $2` + (todas ? '' : ' AND empresa_id = $3'),
    todas ? [desde, ate] : [desde, ate, empresaId]
  );

  return {
    totalAReceber: round2(totalAReceber),
    previstoHoje: round2(previstoHoje),
    atrasado: round2(atrasado),
    previstoProximos7Dias: round2(previstoProximos7Dias),
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

async function marcarComoRecebido(id, dataRecebida, opcoes = {}) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status === 'cancelado') return { errors: { geral: 'Não é possível marcar como recebido um lançamento cancelado.' } };
  if (atual.status === 'recebido') return { errors: { geral: 'Este lançamento já está marcado como recebido.' } };

  const data = dataRecebida && /^\d{4}-\d{2}-\d{2}$/.test(dataRecebida) ? dataRecebida : hojeBRT();
  // Se entrou um valor diferente do previsto, o valor passa a ser o que
  // realmente entrou, e o previsto original fica anotado na observação.
  let novoValor = Number(atual.valor);
  let obs = atual.observacao;
  if (opcoes.valorRecebido !== undefined && opcoes.valorRecebido !== null && opcoes.valorRecebido !== '') {
    const v = Number(opcoes.valorRecebido);
    if (!Number.isFinite(v) || v <= 0) return { errors: { valorRecebido: 'Informe um valor recebido maior que zero.' } };
    if (round2(v) !== round2(novoValor)) {
      obs = ((obs ? obs + ' | ' : '') + 'Previsto R$ ' + novoValor.toFixed(2) + ', recebido R$ ' + round2(v).toFixed(2)).slice(0, 2000);
      novoValor = round2(v);
    }
  }
  const { rows } = await pool.query(
    `UPDATE contas_receber SET status = 'recebido', data_recebida = $1, valor = $2, observacao = $3, updated_at = now() WHERE id = $4 RETURNING *`,
    [data, novoValor, obs, id]
  );
  return { conta: serialize(rows[0]) };
}

// Desfaz uma baixa feita por engano: volta para "a receber".
async function estornarRecebimento(id) {
  const atual = await buscarPorId(id);
  if (!atual) return { notFound: true };
  if (atual.status !== 'recebido') return { errors: { geral: 'Só é possível estornar um lançamento que está recebido.' } };
  const { rows } = await pool.query(
    `UPDATE contas_receber SET status = 'a_receber', data_recebida = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  return { conta: serialize(rows[0]) };
}

// Cria N lançamentos mensais (parcelas) de uma vez.
async function criarContasParceladas(body) {
  const n = parseInt(body.parcelas, 10);
  if (!Number.isInteger(n) || n < 2 || n > 60) return { errors: { parcelas: 'Informe entre 2 e 60 parcelas.' } };
  const { errors, data } = validatePayload(body);
  if (Object.keys(errors).length) return { errors };
  const { somarMesesData } = require('./contasPagar');
  const valores = [];
  if (body.valorEhTotal) {
    const base = Math.floor((data.valor / n) * 100) / 100;
    for (let i = 0; i < n; i++) valores.push(base);
    valores[n - 1] = round2(data.valor - base * (n - 1));
  } else {
    for (let i = 0; i < n; i++) valores.push(data.valor);
  }
  const criadas = [];
  for (let i = 0; i < n; i++) {
    const r = await criarContaReceber({
      ...body,
      descricao: data.descricao + ' (' + (i + 1) + '/' + n + ')',
      valor: valores[i],
      dataPrevista: somarMesesData(data.dataPrevista, i),
    });
    if (r.errors) return { errors: r.errors, criadas: criadas.length };
    criadas.push(r.conta);
  }
  return { contas: criadas };
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
  estornarRecebimento,
  criarContasParceladas,
  cancelarContaReceber,
  excluirContaReceber,
};
