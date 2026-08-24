// Cadastro simples de produtos, por empresa: nome, SKU, custo e status
// (ativo/inativo). Ainda não tem kits, composição nem controle de estoque
// automático.
//
// Desde 24/08/2026: esta é a ÚNICA fonte de custo por SKU usada no cálculo
// de margem das vendas do Mercado Livre (lib/relatorioVendas.js lê direto
// da tabela `produtos`). A antiga tela separada "Custo & Margem" (tabela
// `custos_produto`) foi removida e seus dados migrados pra cá — ver
// db/migrate.js, db/schema.sql e docs/02-decisoes.md. A margem em si
// continua calculada só nas vendas (Pedidos/Visão Geral/Financeiro/
// Relatórios) — esta tela nunca mostra margem, só cadastra/edita SKU e
// custo (a alíquota de imposto, que continua única por empresa, é
// cadastrada aqui também, mas via routes/custos.js -> config_financeiro).
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

function serialize(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    nome: row.nome,
    sku: row.sku,
    custo: Number(row.custo),
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

  if (!partial || body.nome !== undefined) {
    const nome = String(body.nome || '').trim();
    if (!nome) errors.nome = 'Informe o nome do produto.';
    else if (nome.length > 200) errors.nome = 'Nome muito longo (máx. 200 caracteres).';
    else out.nome = nome;
  }

  if (!partial || body.sku !== undefined) {
    const sku = String(body.sku || '').trim();
    if (!sku) errors.sku = 'Informe o SKU.';
    else if (sku.length > 100) errors.sku = 'SKU muito longo (máx. 100 caracteres).';
    else out.sku = sku;
  }

  if (!partial || body.custo !== undefined) {
    const custo = Number(body.custo);
    if (!Number.isFinite(custo) || custo < 0) errors.custo = 'Informe um custo válido (maior ou igual a zero).';
    else out.custo = custo;
  }

  if (body.ativo !== undefined) out.ativo = Boolean(body.ativo);

  return { errors, data: out };
}

// GET /api/produtos?empresaId=ID&status=ativos|inativos&search=texto
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
      conditions.push('(nome ILIKE $' + idx + ' OR sku ILIKE $' + idx + ')');
    }

    const { rows } = await pool.query(
      `SELECT * FROM produtos WHERE ${conditions.join(' AND ')} ORDER BY nome`,
      params
    );
    res.json({ produtos: rows.map(serialize) });
  } catch (err) { next(err); }
});

// GET /api/produtos/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ produto: serialize(rows[0]) });
  } catch (err) { next(err); }
});

// POST /api/produtos — cria
router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = validatePayload(req.body);
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const { rows } = await pool.query(
      `INSERT INTO produtos (empresa_id, nome, sku, custo, ativo)
       VALUES ($1,$2,$3,$4, COALESCE($5, TRUE))
       RETURNING *`,
      [data.empresaId, data.nome, data.sku, data.custo, data.ativo]
    );
    res.status(201).json({ produto: serialize(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { sku: 'Já existe um produto com esse SKU nesta empresa.' } });
    next(err);
  }
});

// PUT /api/produtos/:id — edita (parcial)
router.put('/:id', async (req, res, next) => {
  try {
    const { errors, data } = validatePayload(req.body, { partial: true });
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nada para atualizar.' });

    const fields = [];
    const values = [];
    let i = 1;
    const colMap = { nome: 'nome', sku: 'sku', custo: 'custo', ativo: 'ativo' };
    for (const [key, col] of Object.entries(colMap)) {
      if (data[key] !== undefined) { fields.push(`${col} = $${i++}`); values.push(data[key]); }
    }
    fields.push(`updated_at = now()`);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE produtos SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ produto: serialize(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { sku: 'Já existe um produto com esse SKU nesta empresa.' } });
    next(err);
  }
});

// PATCH /api/produtos/:id/status — ativar/desativar
router.patch('/:id/status', async (req, res, next) => {
  try {
    const ativo = Boolean(req.body.ativo);
    const { rows } = await pool.query(
      `UPDATE produtos SET ativo = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ produto: serialize(rows[0]) });
  } catch (err) { next(err); }
});

module.exports = router;
