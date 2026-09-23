// Venda de Balcão / "Calculadora de Vendas" — ativado em 22/09/2026. Router
// fino: toda a lógica mora em lib/vendaBalcao.js. O produto é sempre
// escolhido do catálogo já existente — o picker do front-end reaproveita a
// rota que já existe (GET /api/produtos?empresaId=&status=ativos), nunca
// duplicada aqui.
const express = require('express');
const { calcularPeriodo } = require('../lib/periodo');
const vendaBalcao = require('../lib/vendaBalcao');

const router = express.Router();

// GET /api/vendas-balcao?empresaId=ID&periodo=30d&status=&search=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, status, search, desde: desdeQuery, ate: ateQuery } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo, { desde: desdeQuery, ate: ateQuery });
    const { vendas } = await vendaBalcao.listarVendas({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
      status,
      search,
    });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      vendas,
    });
  } catch (err) { next(err); }
});

// POST /api/vendas-balcao — registra uma nova venda de balcão
router.post('/', async (req, res, next) => {
  try {
    const result = await vendaBalcao.criarVenda(req.body || {});
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.status(201).json({ venda: result.venda, itens: result.itens });
  } catch (err) { next(err); }
});

// PATCH /api/vendas-balcao/:id/cancelar?empresaId=ID
router.patch('/:id/cancelar', async (req, res, next) => {
  try {
    const empresaId = Number(req.body && req.body.empresaId);
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const result = await vendaBalcao.cancelarVenda(Number(req.params.id), empresaId);
    if (result.notFound) return res.status(404).json({ error: 'Venda não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ venda: result.venda });
  } catch (err) { next(err); }
});

module.exports = router;
