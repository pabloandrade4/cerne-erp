// Contas a Pagar — ativado em 24/08/2026 (ver docs/04-alteracoes.md).
// Router fino: toda a regra de negócio mora em lib/contasPagar.js
// (mesmo padrão de lib/relatorioVendas.js/lib/resultadoVenda.js), pra ficar
// testável sem precisar do Express.
const express = require('express');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const contasPagar = require('../lib/contasPagar');

const router = express.Router();

// GET /api/contas-pagar?empresaId=ID&periodo=30d&status=pendente|pago|vencido|cancelado&search=texto
// A LISTA só filtra por período as contas já PAGAS (pela data de
// pagamento) — pendentes/vencidas/canceladas aparecem sempre, o período
// do header não as esconde. O RESUMO (topo da tela) segue a mesma lógica
// pros KPIs de saldo — ver comentário em lib/contasPagar.js/
// listarContasPagar e resumoContasPagar.
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, status, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { desde, ate } = periodoParaDatasBRT(periodoCalc);

    const [contas, resumo] = await Promise.all([
      contasPagar.listarContasPagar({ empresaId, desde, ate, status, search }),
      contasPagar.resumoContasPagar({ empresaId, desde, ate }),
    ]);

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde, ate },
      contas,
      resumo,
    });
  } catch (err) { next(err); }
});

router.get('/categorias-sugeridas', (req, res) => {
  res.json({ categorias: contasPagar.CATEGORIAS_SUGERIDAS });
});

router.post('/', async (req, res, next) => {
  try {
    const result = await contasPagar.criarContaPagar(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.status(201).json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const result = await contasPagar.atualizarContaPagar(req.params.id, req.body);
    if (result.notFound) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.patch('/:id/pagar', async (req, res, next) => {
  try {
    const result = await contasPagar.marcarComoPago(req.params.id, req.body.dataPagamento);
    if (result.notFound) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.patch('/:id/cancelar', async (req, res, next) => {
  try {
    const result = await contasPagar.cancelarContaPagar(req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ conta: result.conta });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await contasPagar.excluirContaPagar(req.params.id);
    if (result.notFound) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
