// Cadastro de fornecedores, por empresa: razão social/nome, nome fantasia,
// CNPJ ou CPF, telefone, e-mail, observação e status (ativo/inativo).
// Estrutura já preparada (empresa_id) para futuramente relacionar
// fornecedor a produtos e a compras — essa relação em si ainda não existe
// (não foi pedida nesta etapa).
const express = require('express');
const pool = require('../db/pool');
const { onlyDigits, isValidCNPJ, formatCNPJ } = require('../lib/cnpj');
const { isValidCPF, formatCPF } = require('../lib/cpf');

const router = express.Router();

function formatDocumento(digits) {
  if (digits.length === 14) return formatCNPJ(digits);
  if (digits.length === 11) return formatCPF(digits);
  return digits;
}

function serialize(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    razaoSocial: row.razao_social,
    nomeFantasia: row.nome_fantasia,
    documento: row.documento,
    documentoFormatado: formatDocumento(row.documento),
    tipoDocumento: row.documento.length === 11 ? 'CPF' : 'CNPJ',
    telefone: row.telefone,
    email: row.email,
    observacao: row.observacao,
    ativo: row.ativo,
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

  if (!partial || body.documento !== undefined) {
    const documento = onlyDigits(body.documento);
    if (!documento) errors.documento = 'Informe o CNPJ ou CPF.';
    else if (documento.length === 14 && isValidCNPJ(documento)) out.documento = documento;
    else if (documento.length === 11 && isValidCPF(documento)) out.documento = documento;
    else errors.documento = 'CNPJ ou CPF inválido.';
  }

  if (!partial || body.razaoSocial !== undefined) {
    const razaoSocial = String(body.razaoSocial || '').trim();
    if (!razaoSocial) errors.razaoSocial = 'Informe a razão social/nome.';
    else if (razaoSocial.length > 200) errors.razaoSocial = 'Muito longo (máx. 200 caracteres).';
    else out.razaoSocial = razaoSocial;
  }

  if (body.nomeFantasia !== undefined) {
    const nomeFantasia = String(body.nomeFantasia || '').trim();
    if (nomeFantasia.length > 200) errors.nomeFantasia = 'Nome fantasia muito longo (máx. 200 caracteres).';
    else out.nomeFantasia = nomeFantasia || null;
  }

  if (body.telefone !== undefined) {
    const telefone = String(body.telefone || '').trim();
    if (telefone.length > 20) errors.telefone = 'Telefone muito longo.';
    else out.telefone = telefone || null;
  }

  if (body.email !== undefined) {
    const email = String(body.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'E-mail inválido.';
    else if (email.length > 255) errors.email = 'E-mail muito longo.';
    else out.email = email || null;
  }

  if (body.observacao !== undefined) {
    out.observacao = String(body.observacao || '').trim() || null;
  }

  if (body.ativo !== undefined) out.ativo = Boolean(body.ativo);

  return { errors, data: out };
}

// GET /api/fornecedores?empresaId=ID&status=ativos|inativos&search=texto
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, status, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const conditions = ['empresa_id = $1'];
    const params = [empresaId];
    if (status === 'ativos') conditions.push('ativo = TRUE');
    else if (status === 'inativos') conditions.push('ativo = FALSE');
    if (search) {
      params.push('%' + search + '%');
      const idx = params.length;
      conditions.push('(razao_social ILIKE $' + idx + ' OR nome_fantasia ILIKE $' + idx + ' OR documento ILIKE $' + idx + ')');
    }

    const { rows } = await pool.query(
      `SELECT * FROM fornecedores WHERE ${conditions.join(' AND ')} ORDER BY razao_social`,
      params
    );
    res.json({ fornecedores: rows.map(serialize) });
  } catch (err) { next(err); }
});

// GET /api/fornecedores/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fornecedores WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.json({ fornecedor: serialize(rows[0]) });
  } catch (err) { next(err); }
});

// POST /api/fornecedores — cria
router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = validatePayload(req.body);
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const { rows } = await pool.query(
      `INSERT INTO fornecedores (empresa_id, razao_social, nome_fantasia, documento, telefone, email, observacao, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, TRUE))
       RETURNING *`,
      [data.empresaId, data.razaoSocial, data.nomeFantasia || null, data.documento, data.telefone || null, data.email || null, data.observacao || null, data.ativo]
    );
    res.status(201).json({ fornecedor: serialize(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { documento: 'Já existe um fornecedor cadastrado com esse CNPJ/CPF nesta empresa.' } });
    next(err);
  }
});

// PUT /api/fornecedores/:id — edita (parcial)
router.put('/:id', async (req, res, next) => {
  try {
    const { errors, data } = validatePayload(req.body, { partial: true });
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nada para atualizar.' });

    const fields = [];
    const values = [];
    let i = 1;
    const colMap = { razaoSocial: 'razao_social', nomeFantasia: 'nome_fantasia', documento: 'documento', telefone: 'telefone', email: 'email', observacao: 'observacao', ativo: 'ativo' };
    for (const [key, col] of Object.entries(colMap)) {
      if (data[key] !== undefined) { fields.push(`${col} = $${i++}`); values.push(data[key]); }
    }
    fields.push(`updated_at = now()`);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE fornecedores SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.json({ fornecedor: serialize(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { documento: 'Já existe um fornecedor cadastrado com esse CNPJ/CPF nesta empresa.' } });
    next(err);
  }
});

// PATCH /api/fornecedores/:id/status — ativar/desativar
router.patch('/:id/status', async (req, res, next) => {
  try {
    const ativo = Boolean(req.body.ativo);
    const { rows } = await pool.query(
      `UPDATE fornecedores SET ativo = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.json({ fornecedor: serialize(rows[0]) });
  } catch (err) { next(err); }
});

module.exports = router;
