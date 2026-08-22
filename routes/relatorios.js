// Números agregados usados por Visão Geral e Financeiro — reaproveita
// lib/relatorioVendas.js (a mesma função que a listagem de Pedidos usa em
// routes/pedidos.js), pra Visão Geral, Pedidos e Financeiro nunca mostrarem
// um valor diferente pro mesmo período.
const express = require('express');
const { calcularPeriodo } = require('../lib/periodo');
const { buscarPedidosDoPeriodo, resumirPeriodo, serieDiaria } = require('../lib/relatorioVendas');

const router = express.Router();

// GET /api/relatorios/resumo-vendas?empresaId=ID&periodo=30d
// periodo: hoje | ontem | 7d | 30d (padrão) | mes
router.get('/resumo-vendas', async (req, res, next) => {
  try {
    const { empresaId, periodo } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
    });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      totalNoPeriodo,
      resumo: resumirPeriodo(pedidos),
      serieDiaria: serieDiaria(pedidos),
    });
  } catch (err) { next(err); }
});

module.exports = router;
