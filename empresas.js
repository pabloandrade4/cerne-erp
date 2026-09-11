const express = require('express');
const pool = require('../db/pool');
const { onlyDigits, isValidCNPJ, formatCNPJ } = require('../lib/cnpj');

const router = express.Router();

function serialize(row) {
  return {
    id: row.id,
    cnpj: row.cnpj,
    cnpjFormatado: formatCNPJ(row.cnpj),
    razaoSocial: row.razao_social,
    nomeFantasia: row.nome_fantasia,
    ativo: row.ativo,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

function validatePayload(body, { partial = false } = {}) {
  const errors = {};
  const out = {};

  if (!partial || body.cnpj !== undefined) {
    const cnpj = onlyDigits(body.cnpj);
    if (!cnpj) errors.cnpj = 'Informe o CNPJ.';
    else if (!isValidCNPJ(cnpj)) errors.cnpj = 'CNPJ inválido.';
    else out.cnpj = cnpj;
  }

  if (!partial || body.razaoSocial !== undefined) {
    const razaoSocial = String(body.razaoSocial || '').trim();
    if (!razaoSocial) errors.razaoSocial = 'Informe a razão social.';
    else if (razaoSocial.length > 200) errors.razaoSocial = 'Razão social muito longa (máx. 200 caracteres).';
    else out.razaoSocial = razaoSocial;
  }

  if (body.nomeFantasia !== undefined) {
    const nomeFantasia = String(body.nomeFantasia || '').trim();
    if (nomeFantasia.length > 200) errors.nomeFantasia = 'Nome fantasia muito longo (máx. 200 caracteres).';
    else out.nomeFantasia = nomeFantasia || null;
  }

  if (body.ativo !== undefined) {
    out.ativo = Boolean(body.ativo);
  }

  return { errors, data: out };
}

// GET /api/empresas — lista (mais recentes primeiro), com filtro opcional ?status=ativas|inativas
router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    let where = '';
    if (status === 'ativas') where = 'WHERE ativo = TRUE';
    else if (status === 'inativas') where = 'WHERE ativo = FALSE';

    const { rows } = await pool.query(
      `SELECT * FROM empresas ${where} ORDER BY created_at DESC`
    );
    res.json({ empresas: rows.map(serialize) });
  } catch (err) { next(err); }
});

// GET /api/empresas/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM empresas WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.json({ empresa: serialize(rows[0]) });
  } catch (err) { next(err); }
});

// POST /api/empresas — cria
router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = validatePayload(req.body);
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const { rows } = await pool.query(
      `INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
       VALUES ($1, $2, $3, COALESCE($4, TRUE))
       RETURNING *`,
      [data.cnpj, data.razaoSocial, data.nomeFantasia || null, data.ativo]
    );
    res.status(201).json({ empresa: serialize(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { cnpj: 'Já existe uma empresa cadastrada com esse CNPJ.' } });
    next(err);
  }
});

// PUT /api/empresas/:id — edita (parcial)
router.put('/:id', async (req, res, next) => {
  try {
    const { errors, data } = validatePayload(req.body, { partial: true });
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nada para atualizar.' });

    const fields = [];
    const values = [];
    let i = 1;
    const colMap = { cnpj: 'cnpj', razaoSocial: 'razao_social', nomeFantasia: 'nome_fantasia', ativo: 'ativo' };
    for (const [key, col] of Object.entries(colMap)) {
      if (data[key] !== undefined) { fields.push(`${col} = $${i++}`); values.push(data[key]); }
    }
    fields.push(`updated_at = now()`);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE empresas SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.json({ empresa: serialize(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { cnpj: 'Já existe uma empresa cadastrada com esse CNPJ.' } });
    next(err);
  }
});

// PATCH /api/empresas/:id/status — ativar/desativar
router.patch('/:id/status', async (req, res, next) => {
  try {
    const ativo = Boolean(req.body.ativo);
    const { rows } = await pool.query(
      `UPDATE empresas SET ativo = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.json({ empresa: serialize(rows[0]) });
  } catch (err) { next(err); }
});

module.exports = router;
