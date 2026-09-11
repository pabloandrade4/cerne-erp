// Aba "Margem por Anúncio" (Análise) — router fino, ver
// lib/margemAnuncio.js para a regra de negócio.
const express = require('express');
const { calcularPeriodo } = require('../lib/periodo');
const { gerarMargemPorAnuncio } = require('../lib/margemAnuncio');

const router = express.Router();

// GET /api/margem-anuncio?empresaId=ID&periodo=30d&contaId=&sku=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId, sku } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);

    // `periodoChaveAds` é a mesma chave usada para ler ads_metricas_anuncio
    // (lib/ads.js — sincronizada em background pelas 5 janelas de
    // lib/periodo.js), igual à tela Ads.
    const resultado = await gerarMargemPorAnuncio({
      empresaId, contaId: contaId || null, sku: sku || null,
      periodoCalc, periodoChaveAds: periodoCalc.chave,
    });

    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
