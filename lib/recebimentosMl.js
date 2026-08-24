// Tela "Recebimentos" — repasses do Mercado Livre. Ativado em 24/08/2026
// (ver docs/04-alteracoes.md e docs/02-decisoes.md).
//
// SEM tabela própria: reaproveita buscarPedidosDoPeriodo (lib/
// relatorioVendas.js — a mesma fonte única de Visão Geral/Pedidos/
// Financeiro/Relatórios), então nunca duplica pedido nem reimplementa o
// cálculo de tarifas/frete/desconto. Só combina esses componentes já
// corretos numa pergunta financeira DIFERENTE: "quanto o Mercado Livre
// deveria me repassar por essa venda" — não é a margem de contribuição
// (que também desconta imposto e custo do produto, que não são descontados
// pelo marketplace).
//
// IMPORTANTE — dados que NÃO temos: o Mercado Livre não retorna, nos dados
// de pedido/pagamento que esta integração já busca (order.payments[]),
// nenhum campo de liberação/repasse (confirmado lendo o payload real de
// produção em 24/08/2026 — não existe money_release_date nem parecido).
// Por isso `dataPrevistaLiberacao`, `valorRecebido` e `dataRecebimento`
// SEMPRE vêm null aqui — nunca um valor/data inventado — e o status
// sempre parte de "a_liberar" (não temos como saber se já foi liberado,
// então nunca afirmamos isso sem prova; "disponível"/"recebido"/
// "divergente" ficam para quando uma fonte real desse dado existir: um
// endpoint de settlements do ML, ou conciliação manual). Isso é uma
// PREMISSA registrada, não um fato — ver docs/05-problemas-conhecidos.md.
const { buscarPedidosDoPeriodo } = require('./relatorioVendas');
const { round2 } = require('./resultadoVenda');

const STATUS_PAGAMENTO_APROVADO = 'approved';

// Só pedidos com pagamento aprovado (e não cancelados) representam
// dinheiro real que o marketplace pode repassar — os demais (pendente,
// rejeitado, em processo, estornado) não têm valor esperado de repasse
// ainda/mais, então não aparecem nesta tela (mesma regra de "pedido
// cancelado não é venda de verdade" já usada em lib/relatorioVendas.js).
function elegivel(pedido) {
  return !pedido.cancelado && pedido.pagamentoStatus === STATUS_PAGAMENTO_APROVADO;
}

function serializeRecebimento(p) {
  // taxasDescontos = comissão do ML + frete cobrado do vendedor + desconto
  // de cupom — os três descontos que o PRÓPRIO marketplace aplica antes de
  // repassar. NUNCA inclui imposto nem custo do produto (isso não é
  // descontado pelo Mercado Livre, é responsabilidade do vendedor depois).
  const taxasDescontos = (p.tarifasMl === null || p.freteVendedor === null)
    ? null
    : round2(p.tarifasMl + p.freteVendedor + p.desconto);
  const valorLiquidoEsperado = (p.valorTotal === null || taxasDescontos === null)
    ? null
    : round2(p.valorTotal - taxasDescontos);

  return {
    marketplace: 'Mercado Livre',
    loja: p.loja,
    pedidoRef: p.mlOrderId,
    dataVenda: p.dataEfetiva,
    valorBruto: p.valorTotal,
    taxasDescontos,
    valorLiquidoEsperado,
    // Preparado para a conciliação futura (valor esperado x valor
    // repassado) pedida pelo usuário — hoje sempre "não disponível".
    dataPrevistaLiberacao: null,
    valorRecebido: null,
    dataRecebimento: null,
    status: 'a_liberar',
  };
}

async function listarRecebimentosMl({ empresaId, desde, ate }) {
  const { pedidos } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });
  return pedidos.filter(elegivel).map(serializeRecebimento);
}

module.exports = { listarRecebimentosMl, serializeRecebimento, elegivel, STATUS_PAGAMENTO_APROVADO };
