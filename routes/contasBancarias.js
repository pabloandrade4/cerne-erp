// Contas bancárias — cadastro mínimo (Passo 2, 27/08/2026, ver
// docs/04-alteracoes.md). Router fino, regra de negócio em
// lib/contasBancarias.js.
const express = require('express');
const contasBancarias = require('../lib/contasBancarias');

const router = express.Router();

// GET /api/contas-bancarias?empresaId=ID&apenasAtivas=1
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, apenasAtivas } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const contas = await contasBancarias.listarContasBancarias({ empresaId, apenasAtivas: apenasAtivas === '1' || apenasAtivas === 'true' });
    res.json({ contas });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const result = await contasBancarias.criarContaBancaria(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.status(201).json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.patch('/:id/inativar', async (req, res, next) => {
  try {
    const result = await contasBancarias.inativar(req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Conta bancária não encontrada.' });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

module.exports = router;
