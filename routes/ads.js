// Ads (Product Ads do Mercado Livre) — ativado em 25/08/2026, CORRIGIDO EM
// 25/08/2026. Ver lib/ads.js e lib/mlAds.js para o desenho completo (dado
// real quando a API permitir, nunca inventado). A partir desta correção o
// GET abaixo NUNCA mais consulta a API do Mercado Livre ao vivo — lê
// sempre do que lib/adsScheduler.js já sincronizou em background.
const express = require('express');
const { calcularPeriodo, periodoParaDatasBRT } = require('../lib/periodo');
const { listarAds, sincronizarTodasAsContasAds } = require('../lib/ads');
const { obterStatusSincronizacaoAds } = require('../lib/adsScheduler');

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
      periodoChave: periodoCalc.chave,
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
      sincronizacaoAutomatica: obterStatusSincronizacaoAds(),
      ...resultado,
    });
  } catch (err) { next(err); }
});

// POST /api/ads/sincronizar — força um ciclo de sincronização imediato
// (além do automático em background), pra quem acabou de corrigir a
// integração (Marketplaces → Advertising habilitado etc.) não precisar
// esperar o próximo ciclo pra ver o resultado real.
router.post('/sincronizar', async (req, res, next) => {
  try {
    const resultado = await sincronizarTodasAsContasAds();
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
