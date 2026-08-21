// Custo do produto por SKU + configuração de imposto (percentual), por
// empresa. Usado no cálculo do resultado da venda (routes/pedidos.js).
// O imposto é uma configuração do ERP — nunca vem do Mercado Livre.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

function serializeCusto(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    sku: row.sku,
    custo: Number(row.custo),
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

// GET /api/custos-produto?empresaId=ID
router.get('/custos-produto', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const { rows } = await pool.query(
      'SELECT * FROM custos_produto WHERE empresa_id = $1 ORDER BY sku',
      [empresaId]
    );
    res.json({ custos: rows.map(serializeCusto) });
  } catch (err) { next(err); }
});

// POST /api/custos-produto — cadastra ou atualiza o custo de um SKU (upsert por empresa+sku)
router.post('/custos-produto', async (req, res, next) => {
  try {
    const empresaId = req.body.empresaId;
    const sku = String(req.body.sku || '').trim();
    const custo = Number(req.body.custo);

    const errors = {};
    if (!empresaId) errors.empresaId = 'Selecione a empresa.';
    if (!sku) errors.sku = 'Informe o SKU.';
    if (!Number.isFinite(custo) || custo < 0) errors.custo = 'Informe um custo válido (maior ou igual a zero).';
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const { rows } = await pool.query(
      `INSERT INTO custos_produto (empresa_id, sku, custo, atualizado_em)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (empresa_id, sku) DO UPDATE SET custo = EXCLUDED.custo, atualizado_em = now()
       RETURNING *`,
      [empresaId, sku, custo]
    );
    res.status(201).json({ custo: serializeCusto(rows[0]) });
  } catch (err) { next(err); }
});

// PUT /api/custos-produto/:id — edita o valor do custo
router.put('/custos-produto/:id', async (req, res, next) => {
  try {
    const custo = Number(req.body.custo);
    if (!Number.isFinite(custo) || custo < 0) {
      return res.status(400).json({ errors: { custo: 'Informe um custo válido (maior ou igual a zero).' } });
    }
    const { rows } = await pool.query(
      'UPDATE custos_produto SET custo = $1, atualizado_em = now() WHERE id = $2 RETURNING *',
      [custo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Custo não encontrado.' });
    res.json({ custo: serializeCusto(rows[0]) });
  } catch (err) { next(err); }
});

// GET /api/config-financeiro/:empresaId — alíquota de imposto configurada (0 se ainda não configurada)
router.get('/config-financeiro/:empresaId', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM config_financeiro WHERE empresa_id = $1',
      [req.params.empresaId]
    );
    res.json({
      empresaId: Number(req.params.empresaId),
      aliquotaImposto: rows.length ? Number(rows[0].aliquota_imposto) : 0,
    });
  } catch (err) { next(err); }
});

// PUT /api/config-financeiro/:empresaId — define a alíquota de imposto (percentual)
router.put('/config-financeiro/:empresaId', async (req, res, next) => {
  try {
    const aliquota = Number(req.body.aliquotaImposto);
    if (!Number.isFinite(aliquota) || aliquota < 0 || aliquota > 100) {
      return res.status(400).json({ errors: { aliquotaImposto: 'Informe um percentual entre 0 e 100.' } });
    }
    const { rows } = await pool.query(
      `INSERT INTO config_financeiro (empresa_id, aliquota_imposto, atualizado_em)
       VALUES ($1,$2, now())
       ON CONFLICT (empresa_id) DO UPDATE SET aliquota_imposto = EXCLUDED.aliquota_imposto, atualizado_em = now()
       RETURNING *`,
      [req.params.empresaId, aliquota]
    );
    res.json({ empresaId: Number(req.params.empresaId), aliquotaImposto: Number(rows[0].aliquota_imposto) });
  } catch (err) { next(err); }
});

module.exports = router;
