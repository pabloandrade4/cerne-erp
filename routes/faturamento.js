// Faturamento — ativado em 24/08/2026. Router fino: toda a lógica mora em
// lib/faturamento.js.
const express = require('express');
const { calcularPeriodo } = require('../lib/periodo');
const faturamento = require('../lib/faturamento');

const router = express.Router();

// GET /api/faturamento?empresaId=ID&periodo=30d&status=&search=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, status, search, desde: desdeQuery, ate: ateQuery } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo, { desde: desdeQuery, ate: ateQuery });
    const { itens, totalNoPeriodo } = await faturamento.listarFaturamento({
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

// PATCH /api/faturamento/:detailKey/situacao  { status, observacao }
// `detailKey` é "marketplace:id" (ex.: "shopee:57", "balcao:9" — ver
// lib/relatorioVendas.js#serializarPedido), sempre codificado com
// encodeURIComponent pelo front (por causa do ":"), por isso o
// decodeURIComponent aqui. Desde 22/09/2026 (feature "Venda de Balcão")
// não é mais aceito um id numérico puro — o id sozinho pode colidir entre
// Mercado Livre/Shopee/Balcão.
router.patch('/:detailKey/situacao', async (req, res, next) => {
  try {
    const detailKey = decodeURIComponent(req.params.detailKey);
    const result = await faturamento.atualizarSituacao(detailKey, req.body || {});
    if (result.notFound) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ situacao: result.situacao });
  } catch (err) { next(err); }
});

// PATCH /api/faturamento/lote  { detailKeys: [...], status }
router.patch('/lote', async (req, res, next) => {
  try {
    const { detailKeys, status } = req.body || {};
    const result = await faturamento.atualizarSituacaoEmLote(detailKeys, status);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
