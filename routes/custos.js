// Configuração de imposto (alíquota percentual), por empresa. Usado no
// cálculo do resultado da venda (lib/relatorioVendas.js -> lib/resultadoVenda.js).
// O imposto é uma configuração do ERP — nunca vem do Mercado Livre.
//
// Desde 24/08/2026, o cadastro de custo por SKU (antes neste mesmo arquivo,
// como "/api/custos-produto") foi unificado com a tela Produtos — ver
// routes/produtos.js, db/schema.sql e docs/02-decisoes.md. As rotas de
// custo por SKU foram removidas daqui; o campo de alíquota de imposto
// abaixo continua único por empresa (não por produto), só que agora
// chamado a partir da tela Produtos em vez de uma aba separada.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

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
