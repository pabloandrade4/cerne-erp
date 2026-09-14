// Registro central dos especialistas que participam da Daily dos Agentes —
// Etapa 2 (14/09/2026, pedido explícito do usuário). Pra adicionar um
// especialista novo no futuro (Buy Box, SAC/Reclamações/Devoluções, Riscos
// Operacionais — nenhum deles existe como agente real ainda, então NENHUM
// entra aqui por enquanto, nunca como placeholder inventado), basta:
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

const ESPECIALISTAS = [
  especialistaAds,
  especialistaPromocoes,
];

module.exports = { ESPECIALISTAS };
