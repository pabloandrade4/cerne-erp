// Análise de Concorrente — pedido explícito do usuário (19/09/2026). Busca
// SOB DEMANDA (sem ciclo automático ainda — ver lib/concorrente.js para o
// porquê: é a primeira integração deste projeto contra a busca pública do
// Mercado Livre, ainda não testada contra a API de verdade).
const express = require('express');
const { buscarConcorrentesPorProduto } = require('../lib/concorrente');

const router = express.Router();

// GET /api/concorrente/buscar?empresaId=&produtoId=
router.get('/buscar', async (req, res, next) => {
  try {
    const { empresaId, produtoId } = req.query;
    if (!empresaId || !produtoId) return res.status(400).json({ error: 'Informe empresaId e produtoId.' });
    const resultado = await buscarConcorrentesPorProduto({ empresaId: Number(empresaId), produtoId: Number(produtoId) });
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
