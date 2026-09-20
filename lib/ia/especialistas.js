// Registro central dos especialistas que participam da Daily dos Agentes —
// Etapa 2 (14/09/2026, pedido explícito do usuário). Pra adicionar um
// especialista novo no futuro (Buy Box, Riscos Operacionais — nenhum deles
// existe como agente real ainda, então NENHUM entra aqui por enquanto, nunca
// como placeholder inventado), basta:
//   1) implementar o mesmo contrato:
//        gerarResumoDiario({ empresaId, dataReferencia, reuniaoAnteriorId })
//          -> { achados: [{ tipo, titulo, descricao, dados, prioridade,
//                           sku, campanhaId, pedidoId, decisaoTabela,
//                           decisaoId }, ...] }
//      tipo: 'problema' | 'oportunidade' | 'risco' | 'alteracao'
//      prioridade: 'critica' | 'alta' | 'media' | 'baixa' | null
//      decisaoTabela/decisaoId: apontam pra uma decisão real já existente
//      (ex.: ia_decisoes_ads) quando o achado corresponde a uma ação
//      concreta com fluxo de aprovar/recusar próprio — null quando o achado
//      é só informativo (ex.: um risco sem ação associada ainda).
//   2) cadastrar a identidade em ia_agentes (db/schema.sql) com o mesmo
//      `codigo` usado como AGENTE_CODIGO do módulo.
//   3) acrescentar uma linha no array abaixo.
// Nenhum outro arquivo (lib/ia/dailyCiclo.js, routes/daily.js) precisa
// saber nada específico do agente novo.
const especialistaAds = require('./especialistaAds');
const especialistaPromocoes = require('./especialistaPromocoes');
// 19/09/2026, pedido explícito do usuário: "quero que essas ia nunca pare
// de trabalhar... e quero que os relatórios... me envie tudo no whatsapp"
// — Anúncios (Radar) e Análise de Concorrente entram na Daily do mesmo
// jeito que Ads/Promoções, cada um só reaproveitando o que seu próprio
// agente automático já persistiu (nunca uma chamada nova aqui). SAC ainda
// não entra nesta etapa — fica pra uma próxima, combinada com o usuário.
const especialistaAnuncios = require('./especialistaAnuncios');
const especialistaConcorrente = require('./especialistaConcorrente');
// 20/09/2026, pedido explícito do usuário ("Pwrai que tenho que te falar das
// outras ia" + confirmação de incluir SAC agora): SAC Mercado Livre e SAC
// Shopee entram na Daily do mesmo jeito que os demais, cada um só
// reaproveitando o que seu próprio ciclo automático já persistiu (nunca uma
// chamada nova aqui) — ver especialistaSacComum.js.
const especialistaSacMercadoLivre = require('./especialistaSacMercadoLivre');
const especialistaSacShopee = require('./especialistaSacShopee');

const ESPECIALISTAS = [
  especialistaAds,
  especialistaPromocoes,
  especialistaAnuncios,
  especialistaConcorrente,
  especialistaSacMercadoLivre,
  especialistaSacShopee,
];

module.exports = { ESPECIALISTAS };
