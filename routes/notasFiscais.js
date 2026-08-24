// Notas Fiscais — ativado em 24/08/2026. Router fino: toda a lógica mora
// em lib/notasFiscais.js. Sem integração real com SEFAZ nesta etapa.
const express = require('express');
const { calcularPeriodo } = require('../lib/periodo');
const notasFiscais = require('../lib/notasFiscais');

const router = express.Router();

// GET /api/notas-fiscais?empresaId=ID&periodo=30d&status=&search=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, status, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { itens, totalNoPeriodo } = await notasFiscais.listarNotasFiscais({
      empresaId,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
      status,
      search,
    });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      itens,
      totalNoPeriodo,
    });
  } catch (err) { next(err); }
});

// PUT /api/notas-fiscais/pedido/:pedidoId  { numero, serie, chaveAcesso, valor, dataEmissao, status, observacao }
// Upsert por pedido — cria a nota se ainda não existir, atualiza se já existir.
router.put('/pedido/:pedidoId', async (req, res, next) => {
  try {
    const result = await notasFiscais.registrarNota(req.params.pedidoId, req.body || {});
    if (result.notFound) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ nota: result.nota });
  } catch (err) { next(err); }
});

module.exports = router;
