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

// GET /api/ads?empresaId=ID&periodo=30d&contaId=&desde=&ate=
// `desde`/`ate` (YYYY-MM-DD) só valem quando periodo=personalizado (ver
// lib/periodo.js) — pedido explícito do usuário (12/09/2026) pra poder
// escolher qualquer intervalo de datas nesta tela também. Os cards/gráfico
// continuam vindo de ads_diario (já é dado dia a dia, cobre qualquer
// intervalo sem mudança nenhuma); a tabela por anúncio, quando o período é
// personalizado, busca a métrica AO VIVO na API do Mercado Livre pro
// intervalo exato pedido (ver lib/ads.js#buscarMetricasPorAnuncio) — única
// exceção deliberada à regra acima de nunca consultar a API dentro da
// requisição HTTP, porque não dá pra pré-sincronizar em segundo plano todo
// intervalo de datas possível que o usuário decida escolher.
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, periodo, contaId, desde: desdeQuery, ate: ateQuery } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const periodoCalc = calcularPeriodo(periodo, { desde: desdeQuery, ate: ateQuery });
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
