// Sincronização automática do Ads da Shopee (16/10/2026) — roda no servidor,
// nunca depende da tela aberta. Intervalo configurável por SHOPEE_ADS_SYNC_INTERVALO_MS.
const { sincronizarTodasAsContasAdsShopee } = require('./shopeeAds');
const INTERVALO_MS = Number(process.env.SHOPEE_ADS_SYNC_INTERVALO_MS) || 30 * 60 * 1000;
let emExecucao = false;
async function ciclo() {
  if (emExecucao) return;
  emExecucao = true;
  try {
    const r = await sincronizarTodasAsContasAdsShopee();
    r.filter((x) => !x.ok).forEach((x) => console.error(`[Ads Shopee] conta ${x.contaId}: ${x.mensagem}`));
  } catch (err) { console.error('[Ads Shopee] ciclo falhou:', err.message); }
  emExecucao = false;
}
function iniciar() {
  setTimeout(ciclo, 60 * 1000);
  setInterval(ciclo, INTERVALO_MS).unref();
}
module.exports = { iniciar, ciclo };
