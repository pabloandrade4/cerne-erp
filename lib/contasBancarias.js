// Contas bancárias — cadastro mínimo (Passo 2 da tarefa "Recebimentos +
// Fluxo de Caixa + IA Gestora", 27/08/2026, ver docs/02-decisoes.md).
// Só o necessário pra separar extratos de contas/empresas diferentes —
// nenhum dado sensível é obrigatório, nenhuma integração bancária real
// (o usuário importa o extrato manualmente por planilha, ver
// lib/extratoBancario.js).
const pool = require('../db/pool');

function serialize(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    nome: row.nome,
    banco: row.banco,
    agencia: row.agencia,
    numeroConta: row.numero_conta,
    ativa: row.ativa,
  };
}

async function listarContasBancarias({ empresaId, apenasAtivas } = {}) {
  if (!empresaId) return [];
  const condicoes = ['empresa_id = $1'];
  const params = [empresaId];
  if (apenasAtivas) condicoes.push('ativa = TRUE');
  const { rows } = await pool.query(
    `SELECT * FROM contas_bancarias WHERE ${condicoes.join(' AND ')} ORDER BY nome`,
    params
  );
  return rows.map(serialize);
}

function validarPayload(body) {
  const errors = {};
  const empresaId = Number(body.empresaId);
  if (!empresaId) errors.empresaId = 'Selecione a empresa.';
  const nome = String(body.nome || '').trim();
  if (!nome) errors.nome = 'Informe um nome/apelido pra esta conta (ex: "Banco X - Conta Corrente").';
  return {
    errors,
    data: {
      empresaId,
      nome,
      banco: String(body.banco || '').trim() || null,
      agencia: String(body.agencia || '').trim() || null,
      numeroConta: String(body.numeroConta || '').trim() || null,
    },
  };
}

async function criarContaBancaria(body) {
  const { errors, data } = validarPayload(body);
  if (Object.keys(errors).length) return { errors };
  try {
    const { rows } = await pool.query(
      `INSERT INTO contas_bancarias (empresa_id, nome, banco, agencia, numero_conta)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [data.empresaId, data.nome, data.banco, data.agencia, data.numeroConta]
    );
    return { conta: serialize(rows[0]) };
  } catch (err) {
    if (err.code === '23505') return { errors: { nome: 'Já existe uma conta bancária com esse nome nesta empresa.' } };
    throw err;
  }
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM contas_bancarias WHERE id = $1', [id]);
  return rows[0] ? serialize(rows[0]) : null;
}

async function inativar(id) {
  const { rows } = await pool.query(
    `UPDATE contas_bancarias SET ativa = FALSE, updated_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!rows.length) return { notFound: true };
  return { conta: serialize(rows[0]) };
}

module.exports = {
  listarContasBancarias,
  criarContaBancaria,
  buscarPorId,
  inativar,
};
