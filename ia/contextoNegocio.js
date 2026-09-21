// Camada de contexto de negócio da IA Gestora — Etapa (b) da tarefa "IA
// Gestora que conhece o negócio" (27/08/2026, ver docs/02-decisoes.md e
// docs/PROPOSTA-contexto-negocio-ia-gestora.md).
//
// Princípio central da proposta aprovada pelo usuário: "compor, não
// recriar" — este arquivo NUNCA calcula um número novo. `montarRaioXEmpresa`
// é só uma casca de composição em cima de lib/visaoGeralPainel.js (mesma
// fonte da tela Visão Geral) e lib/recebimentosMl.js (mesma fonte da tela
// Recebimentos), pensada pra dar à IA, numa única chamada, uma "fotografia"
// ampla da empresa (vendas por canal, fluxo de caixa, conexões, alertas,
// Radar e o detalhe de recebimentos por status) — sem ela precisar
// encadear 4-5 ferramentas separadas só pra responder "como está o
// negócio hoje" ou "me dê um raio-X da empresa".
//
// Por que vive em lib/ia/ (diferente de lib/mapaProdutos.js, que fica fora
// de lib/ia/): esta composição especificamente pensada pro formato que a
// IA consome (nunca usada pela tela Visão Geral, que já chama
// painelVisaoGeral diretamente) — é a convenção de nomes já aprovada pelo
// usuário (docs/02-decisoes.md, ponto 1).
const { painelVisaoGeral } = require('../visaoGeralPainel');
const { resumoRecebimentosMarketplace } = require('../recebimentosMl');

async function montarRaioXEmpresa({ empresaId, periodoChave }) {
  const painel = await painelVisaoGeral({ empresaId, periodoChave });

  // Detalhe de recebimentos por status (a_receber/disponivel/recebido,
  // próximos 7/15/30 dias) — mais rico que o resumo simples já embutido em
  // painel.fluxoCaixa.recebimentosMl (que só soma o líquido esperado dos
  // pedidos do período, sem status persistido). Nunca quebra o raio-X
  // inteiro se falhar (mesma disciplina já usada por painelVisaoGeral com o
  // Radar) — só fica ausente, com o motivo explicado.
  let recebimentosDetalhado = null;
  let recebimentosDetalhadoError = null;
  try {
    recebimentosDetalhado = await resumoRecebimentosMarketplace(Number(empresaId));
  } catch (err) {
    recebimentosDetalhadoError = err.message || 'erro desconhecido';
  }

  return {
    ...painel,
    recebimentosMarketplacePorStatus: recebimentosDetalhado,
    recebimentosMarketplacePorStatusError: recebimentosDetalhadoError,
  };
}

module.exports = { montarRaioXEmpresa };
