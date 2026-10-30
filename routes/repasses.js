// Repasses ML/Shopee (Fase 2, 30/10/2026) — ver lib/repasses.js.
const express = require('express');
const repasses = require('../lib/repasses');

const router = express.Router();

// GET /api/repasses?empresaId=ID|todas&diasMl=14&diasShopee=7
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, diasMl, diasShopee } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (String(empresaId) === 'todas') {
      const empresas = (await require('../db/pool').query('SELECT id, COALESCE(nome_fantasia, razao_social) AS nome FROM empresas ORDER BY id')).rows;
      const partes = await Promise.all(empresas.map(async (e) => ({ e, r: await repasses.listarRepasses({ empresaId: e.id, diasMl, diasShopee }) })));
      const base = partes[0] ? partes[0].r : { resumo: {}, grupos: [], itens: [] };
      const soma = (a, b) => Math.round(((a || 0) + (b || 0)) * 100) / 100;
      const resumo = { ...base.resumo, semDados: 0 };
      for (const mk of ['mercado_livre', 'shopee']) {
        resumo[mk] = { nome: mk === 'shopee' ? 'Shopee' : 'Mercado Livre', aLiberar: 0, provavelmenteLiberado: 0, pedidos: 0 };
      }
      const grupos = [], itens = [];
      for (const { e, r } of partes) {
        resumo.semDados += r.resumo.semDados || 0;
        for (const mk of ['mercado_livre', 'shopee']) {
          resumo[mk].aLiberar = soma(resumo[mk].aLiberar, r.resumo[mk].aLiberar);
          resumo[mk].provavelmenteLiberado = soma(resumo[mk].provavelmenteLiberado, r.resumo[mk].provavelmenteLiberado);
          resumo[mk].pedidos += r.resumo[mk].pedidos;
        }
        grupos.push(...r.grupos.map((g) => ({ ...g, empresaNome: e.nome })));
        itens.push(...r.itens.map((i) => ({ ...i, empresaNome: e.nome })));
      }
      grupos.sort((a, b) => a.data.localeCompare(b.data));
      itens.sort((a, b) => a.dataLiberacaoEstimada.localeCompare(b.dataLiberacaoEstimada));
      return res.json({ resumo, grupos, itens });
    }
    res.json(await repasses.listarRepasses({ empresaId: Number(empresaId), diasMl, diasShopee }));
  } catch (err) { next(err); }
});

// POST /api/repasses/lancar-previsao  { empresaId, diasMl, diasShopee }
router.post('/lancar-previsao', async (req, res, next) => {
  try {
    const r = await repasses.lancarPrevisao(req.body || {});
    if (r.errors) return res.status(400).json({ errors: r.errors });
    res.json(r);
  } catch (err) { next(err); }
});

module.exports = router;
