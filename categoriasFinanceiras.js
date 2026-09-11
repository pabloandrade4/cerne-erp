// Categorias financeiras — ativado em 31/08/2026. Router fino, mesma
// filosofia do resto do projeto (regra de negócio mora em
// lib/categoriasFinanceiras.js).
const express = require('express');
const categorias = require('../lib/categoriasFinanceiras');

const router = express.Router();

// GET /api/categorias-financeiras?empresaId=ID&incluirInativas=1
router.get('/', async (req, res, next) => {
  try {
    if (!req.query.empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const lista = await categorias.listarCategorias({
      empresaId: req.query.empresaId,
      incluirInativas: req.query.incluirInativas === '1' || req.query.incluirInativas === 'true',
    });
    res.json({ categorias: lista });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const r = await categorias.criarCategoria(req.body);
    if (r.errors) return res.status(400).json({ errors: r.errors });
    res.status(201).json(r);
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const r = await categorias.atualizarCategoria(req.params.id, req.body);
    if (r.notFound) return res.status(404).json({ error: 'Categoria não encontrada.' });
    if (r.errors) return res.status(400).json({ errors: r.errors });
    res.json(r);
  } catch (err) { next(err); }
});

router.patch('/:id/desativar', async (req, res, next) => {
  try {
    const r = await categorias.definirAtiva(req.params.id, false);
    if (r.notFound) return res.status(404).json({ error: 'Categoria não encontrada.' });
    res.json(r);
  } catch (err) { next(err); }
});

router.patch('/:id/ativar', async (req, res, next) => {
  try {
    const r = await categorias.definirAtiva(req.params.id, true);
    if (r.notFound) return res.status(404).json({ error: 'Categoria não encontrada.' });
    res.json(r);
  } catch (err) { next(err); }
});

module.exports = router;
