// Notas Fiscais — ativado em 24/08/2026. Router fino: toda a lógica mora
// em lib/notasFiscais.js. Sem integração real com SEFAZ nesta etapa.
const express = require('express');
const { calcularPeriodo } = require('../lib/periodo');
const notasFiscais = require('../lib/notasFiscais');

const router = express.Router();

// GET /api/notas-fiscais?empresaId=ID&periodo=30d&status=&search=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, status, search, desde: desdeQuery, ate: ateQuery } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo, { desde: desdeQuery, ate: ateQuery });
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

// PUT /api/notas-fiscais/pedido/:detailKey  { numero, serie, chaveAcesso, valor, dataEmissao, status, observacao }
// Upsert por pedido — cria a nota se ainda não existir, atualiza se já existir.
// `detailKey` é "marketplace:id" (ver lib/faturamento.js — mesmo padrão),
// sempre codificado com encodeURIComponent pelo front por causa do ":".
router.put('/pedido/:detailKey', async (req, res, next) => {
  try {
    const detailKey = decodeURIComponent(req.params.detailKey);
    const result = await notasFiscais.registrarNota(detailKey, req.body || {});
    if (result.notFound) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ nota: result.nota });
  } catch (err) { next(err); }
});

module.exports = router;
