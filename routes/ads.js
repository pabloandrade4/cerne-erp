// Ads (Product Ads do Mercado Livre) — ativado em 25/08/2026, corrigido em
// 25/08/2026. Ver lib/ads.js e lib/mlAds.js para o desenho completo (dado
// real quando a API permitir, nunca inventado).
const express = require('express');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const { listarAds } = require('../lib/ads');

const router = express.Router();

// GET /api/ads?empresaId=ID&periodo=30d&contaId=
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo);
    const { desde: desdeStr, ate: ateStr } = periodoParaDatasBRT(periodoCalc);

    // Cards "Gasto hoje"/"Gasto no mês" são sempre a data real de hoje em
    // BRT — janela fixa, independente do período escolhido no filtro da
    // tela (mesmo padrão de fuso de lib/periodo.js usado em todo o ERP).
    const hojeCalc = calcularPeriodo('hoje');
    const { desde: hojeStr } = periodoParaDatasBRT(hojeCalc);
    const mesCalc = calcularPeriodo('mes');
    const { desde: mesDesdeStr, ate: mesAteStr } = periodoParaDatasBRT(mesCalc);

    const resultado = await listarAds({
      empresaId,
      contaId: contaId || null,
      desde: periodoCalc.desde,
      ate: periodoCalc.ate,
      desdeStr,
      ateStr,
      mesDesdeStr,
      mesAteStr,
      hojeStr,
    });

    res.json({
      periodo: { chave: periodoCalc.chave, label: periodoCalc.label, desde: periodoCalc.desde, ate: periodoCalc.ate },
      ...resultado,
    });
  } catch (err) { next(err); }
});

module.exports = router;
