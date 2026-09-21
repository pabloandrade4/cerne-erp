// Análise de Concorrente — pedido explícito do usuário (19/09/2026). Busca
// SOB DEMANDA (sem ciclo automático ainda — ver lib/concorrente.js para o
// porquê: é a primeira integração deste projeto contra a busca pública do
// Mercado Livre, ainda não testada contra a API de verdade).
const express = require('express');
const {
  buscarConcorrentesPorProduto, testarListagemPorVendedor,
  cadastrarConcorrente, listarConcorrentesMonitorados, removerConcorrenteMonitorado,
} = require('../lib/concorrente');

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

// GET /api/concorrente/testar-vendedor?empresaId=&url=
// TESTE de viabilidade (20/09/2026) — ver comentário grande em
// lib/concorrente.js#testarListagemPorVendedor. É GET de propósito, pra dar
// pra testar só colando o link e abrindo no navegador — mesmo espírito de
// GET /api/integracoes/whatsapp/testar. NÃO é a funcionalidade final de
// monitorar concorrente automaticamente — só confirma se o caminho técnico
// funciona antes de construir o resto.
router.get('/testar-vendedor', async (req, res, next) => {
  try {
    const { empresaId, url } = req.query;
    if (!empresaId || !url) return res.status(400).json({ error: 'Informe empresaId e url (o link do anúncio/loja do concorrente, com o item_id nele).' });
    const resultado = await testarListagemPorVendedor({ empresaId: Number(empresaId), url });
    res.status(resultado.ok ? 200 : 502).json(resultado);
  } catch (err) { next(err); }
});

// ============================================================================
// Cadastro manual de concorrente por SKU (20/09/2026) — ver comentário
// grande em lib/concorrente.js e db/schema.sql (tabela
// concorrentes_monitorados). Nunca valida/busca o link automaticamente:
// só guarda o que o usuário colou, pra alimentar o Agente Coordenador da
// Daily (regra R4) e pra ele mesmo abrir o link quando quiser conferir.
// GET /api/concorrente/monitorados?empresaId=&sku=
router.get('/monitorados', async (req, res, next) => {
  try {
    const { empresaId, sku } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const linhas = await listarConcorrentesMonitorados({ empresaId: Number(empresaId), sku: sku || null });
    res.json({ concorrentes: linhas });
  } catch (err) { next(err); }
});

// POST /api/concorrente/monitorados  { empresaId, sku, url, apelido? }
router.post('/monitorados', async (req, res, next) => {
  try {
    const { empresaId, sku, url, apelido } = req.body || {};
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const linha = await cadastrarConcorrente({ empresaId: Number(empresaId), sku, url, apelido });
    res.status(201).json(linha);
  } catch (err) { next(err); }
});

// DELETE /api/concorrente/monitorados/:id?empresaId=
router.delete('/monitorados/:id', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    await removerConcorrenteMonitorado({ empresaId: Number(empresaId), id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
