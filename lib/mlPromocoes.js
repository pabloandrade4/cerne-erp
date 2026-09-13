// Cliente da API de Promoções (Central de Promoções) do Mercado Livre —
// primeira etapa (12/09/2026), pedido explícito do usuário: "criar um
// agente de IA para o Mercado Livre para gerenciar a central de
// promoções". Antes de qualquer coisa automática, esta etapa é SÓ
// DIAGNÓSTICO — nunca aplica, edita ou remove nenhuma promoção — porque:
//   1) A conta ML deste ERP nunca chamou este endpoint antes, então não
//      sabemos ainda se o aplicativo cadastrado no Mercado Livre já tem
//      permissão para a API de Promoções (pode precisar ser liberada no
//      painel de desenvolvedores do Mercado Livre, do mesmo jeito que
//      Product Ads precisou).
//   2) A documentação pública tem duas variantes: uma para vendedor comum
//      (o que interessa aqui, contas MLB domésticas) e outra para quem usa
//      "Global Selling" (venda internacional, preços em USD, com headers
//      extras como X-Client-Id/X-Caller-Id) — como as contas conectadas
//      neste ERP são domésticas (site_id MLB), usamos a variante simples
//      abaixo, mas só o diagnóstico ao vivo confirma de verdade.
// Mesma regra do resto do projeto: nunca inventar dado — se a chamada
// falhar, devolve o status/corpo REAIS do erro do Mercado Livre, nunca um
// valor calculado ou estimado.
const ml = require('./mercadolivre');

// GET /seller-promotions/users/{ml_user_id} — devolve todas as promoções
// (de todos os tipos: DEAL, PRICE_DISCOUNT, LIGHTNING, MARKETPLACE_CAMPAIGN
// etc — ver lib/mlPromocoes.js no changelog/docs) disponíveis pro vendedor,
// com o status de cada uma. `app_version=v2` como query param é o que a
// documentação (developers.mercadolibre.com.ar/manage-promotion) pede para
// contas de vendedor comum.
async function buscarPromocoesDaConta(accessToken, mlUserId) {
  const path = `/seller-promotions/users/${mlUserId}?app_version=v2`;
  try {
    const data = await ml.apiGet(path, accessToken);
    return { ok: true, status: 200, path, data };
  } catch (e) {
    return { ok: false, status: e.status || null, path, erro: e.message, detalheApi: e.data || null };
  }
}

module.exports = { buscarPromocoesDaConta };
