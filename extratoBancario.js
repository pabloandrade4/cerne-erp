// Importação de extrato bancário (Passo 2, 27/08/2026, ver
// docs/04-alteracoes.md). Fluxo em 2 passos, exatamente como pedido:
//   1) POST /preview  — lê a planilha, sugere mapeamento, mostra prévia
//      (quantas movimentações, quanto em entradas/saídas, quantas já
//      existiam) SEM gravar nada.
//   2) POST /confirmar — grava de fato, usando os movimentos já
//      calculados na prévia (evita reprocessar/reenviar o arquivo).
// O arquivo em si (bytes da planilha) nunca é persistido — só passa pela
// memória do processo durante a requisição. Ver lib/extratoBancario.js.
const express = require('express');
const extratoBancario = require('../lib/extratoBancario');

const router = express.Router();

// POST /api/extrato/preview
// body: { empresaId, contaBancariaId, nomeArquivo, formato: 'xlsx'|'csv',
//         conteudoBase64, mapeamento? }
router.post('/preview', async (req, res, next) => {
  try {
    const { empresaId, contaBancariaId, nomeArquivo, formato, conteudoBase64, mapeamento } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (!contaBancariaId) return res.status(400).json({ error: 'Informe contaBancariaId.' });
    if (!conteudoBase64) return res.status(400).json({ error: 'Envie o conteúdo do arquivo (conteudoBase64).' });

    const resultado = await extratoBancario.previsualizarImportacao({
      conteudoBase64, formato, nomeArquivo, mapeamento, contaBancariaId,
    });
    if (resultado.errors) return res.status(400).json(resultado);
    res.json(resultado);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// POST /api/extrato/confirmar
// body: { empresaId, contaBancariaId, nomeArquivo, formato, mapeamento,
//         movimentos: [...] (os mesmos devolvidos pela prévia), importadoPor }
router.post('/confirmar', async (req, res, next) => {
  try {
    const { empresaId, contaBancariaId, nomeArquivo, formato, mapeamento, movimentos, importadoPor } = req.body || {};
    const result = await extratoBancario.confirmarImportacao({
      empresaId, contaBancariaId, nomeArquivo, formato, mapeamento, movimentos, importadoPor,
    });
    if (result.errors) return res.status(400).json({ errors: result.errors });
    res.status(201).json({ importacao: result.importacao });
  } catch (err) { next(err); }
});

// GET /api/extrato/importacoes?empresaId=ID&contaBancariaId=ID
router.get('/importacoes', async (req, res, next) => {
  try {
    const { empresaId, contaBancariaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const importacoes = await extratoBancario.listarImportacoes({ empresaId, contaBancariaId });
    res.json({ importacoes });
  } catch (err) { next(err); }
});

// GET /api/extrato/movimentos?empresaId=ID&contaBancariaId=ID&desde=&ate=&statusConciliacao=
router.get('/movimentos', async (req, res, next) => {
  try {
    const { empresaId, contaBancariaId, desde, ate, statusConciliacao } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const movimentos = await extratoBancario.listarMovimentos({ empresaId, contaBancariaId, desde, ate, statusConciliacao });
    res.json({ movimentos });
  } catch (err) { next(err); }
});

module.exports = router;
