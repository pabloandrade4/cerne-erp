// Devoluções (separadas de Cancelamento) — 26/09/2026, pedido explícito do
// usuário: entender "oque é devolção e oque é cancelamento de pedido".
//
// Dois blocos de teste, nenhum precisa de Postgres:
//   1) Classificação de devolução (lib/devolucoes.js) — funções puras que
//      decidem se um claim do Mercado Livre / uma devolução da Shopee virou
//      'confirmada' (reembolso já aconteceu), 'negada_ou_cancelada' ou
//      continua 'aberta' — nunca inventa 'confirmada' sem sinal claro de
//      reembolso na própria resposta da API.
//   2) resumirPeriodo/serieDiaria (lib/relatorioVendas.js) — confirma que
//      devolução confirmada some do faturamento real (igual cancelamento),
//      é contada à parte em `devolucoes` (nunca somada em `cancelados`), e
//      um pedido cancelado nunca conta como devolvido mesmo que a API tenha
//      marcado os dois (mutuamente exclusivos, cancelado sempre vence).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classificarClaimMercadoLivre, classificarDevolucaoShopee } = require('../lib/devolucoes');
const { resumirPeriodo, serieDiaria } = require('../lib/relatorioVendas');

describe('classificarClaimMercadoLivre — só confirma reembolso com sinal claro da própria API', () => {
  test('claim ainda aberto (status !== closed) fica "aberta", nunca confirmada no escuro', () => {
    const r = classificarClaimMercadoLivre({ status: 'opened', resolution: null });
    assert.equal(r.status, 'aberta');
    assert.equal(r.valorReembolsado, null);
    assert.equal(r.dataConclusao, null);
  });

  test('claim fechado com resolution mencionando refund -> confirmada, valor somado dos coverages', () => {
    const r = classificarClaimMercadoLivre({
      status: 'closed',
      resolution: { reason: 'payment_refunded', coverages: [{ amount: 30 }, { amount: 3.47 }] },
      last_updated: '2026-09-20T10:00:00Z',
    });
    assert.equal(r.status, 'confirmada');
    assert.equal(r.valorReembolsado, 33.47);
    assert.equal(r.dataConclusao, '2026-09-20T10:00:00Z');
  });

  test('claim fechado com resolution sem refund -> negada_ou_cancelada, nunca "confirmada"', () => {
    const r = classificarClaimMercadoLivre({
      status: 'closed',
      resolution: { reason: 'buyer_kept_item' },
    });
    assert.equal(r.status, 'negada_ou_cancelada');
    assert.equal(r.valorReembolsado, null);
  });

  test('claim fechado com refund mas sem coverages numéricos -> confirmada com valor null (nunca chuta um valor)', () => {
    const r = classificarClaimMercadoLivre({
      status: 'closed',
      resolution: { reason: 'refund_to_buyer' },
    });
    assert.equal(r.status, 'confirmada');
    assert.equal(r.valorReembolsado, null);
  });
});

describe('classificarDevolucaoShopee — mesmo espírito conservador da Shopee', () => {
  test('status COMPLETED -> confirmada, usa refund_amount da própria API', () => {
    const r = classificarDevolucaoShopee({ status: 'COMPLETED', refund_amount: 45.9 });
    assert.equal(r.status, 'confirmada');
    assert.equal(r.valorReembolsado, 45.9);
  });

  test('status CANCELLED -> negada_ou_cancelada, nunca conta como devolução', () => {
    const r = classificarDevolucaoShopee({ status: 'CANCELLED' });
    assert.equal(r.status, 'negada_ou_cancelada');
    assert.equal(r.valorReembolsado, null);
  });

  test('qualquer outro status (REQUESTED/PROCESSING/ACCEPTED) fica "aberta"', () => {
    for (const status of ['REQUESTED', 'PROCESSING', 'ACCEPTED', 'algo_desconhecido']) {
      const r = classificarDevolucaoShopee({ status });
      assert.equal(r.status, 'aberta', `status ${status} deveria ficar aberta`);
    }
  });
});

// Fabrica um "pedido serializado" mínimo (mesmo shape de serializarPedido em
// lib/relatorioVendas.js) só com os campos que resumirPeriodo/serieDiaria
// realmente leem — evita ter que subir um Postgres pra testar essa regra de
// negócio pura.
function pedido({ valorTotal, cancelado = false, devolvido = false, valorReembolsado = null, dataEfetiva = '2026-09-20T10:00:00Z' }) {
  return {
    valorTotal,
    desconto: 0,
    tarifasMl: 0,
    freteVendedor: 0,
    imposto: 0,
    custoProduto: 0,
    calculoCompleto: true,
    margemContribuicao: valorTotal,
    comissaoEstimada: false,
    cancelado,
    devolvido,
    valorReembolsado,
    dataEfetiva,
  };
}

describe('resumirPeriodo — devolução confirmada some do faturamento real e conta à parte', () => {
  test('devolução confirmada não entra em faturamento/qtdPedidos, mas aparece em devolucoes', () => {
    const pedidos = [
      pedido({ valorTotal: 100 }),
      pedido({ valorTotal: 50, devolvido: true, valorReembolsado: 48 }),
    ];
    const r = resumirPeriodo(pedidos);
    assert.equal(r.qtdPedidos, 1);
    assert.equal(r.faturamento.valor, 100);
    assert.equal(r.devolucoes.quantidade, 1);
    assert.equal(r.devolucoes.valor, 48, 'usa o valor confirmado pela API (valorReembolsado), não o valorTotal do pedido');
    assert.equal(r.cancelados.quantidade, 0, 'devolução nunca conta como cancelamento');
  });

  test('devolução SEM valorReembolsado confirmado ainda cai pro valorTotal do pedido (nunca fica invisível no total de devoluções)', () => {
    const pedidos = [pedido({ valorTotal: 75, devolvido: true, valorReembolsado: null })];
    const r = resumirPeriodo(pedidos);
    assert.equal(r.devolucoes.quantidade, 1);
    assert.equal(r.devolucoes.valor, 75);
  });

  test('pedido cancelado E marcado como devolvido: cancelado sempre vence — conta só em cancelados, nunca nos dois', () => {
    const pedidos = [pedido({ valorTotal: 60, cancelado: true, devolvido: true, valorReembolsado: 60 })];
    const r = resumirPeriodo(pedidos);
    assert.equal(r.cancelados.quantidade, 1);
    assert.equal(r.devolucoes.quantidade, 0, 'um pedido cancelado nunca soma em devolucoes, mesmo se a API também marcou devolvido');
    assert.equal(r.qtdPedidos, 0);
  });

  test('empresa sem nenhuma devolução: devolucoes.quantidade=0, valor=null (nunca 0 disfarçado de "sem devolução confirmada")', () => {
    const r = resumirPeriodo([pedido({ valorTotal: 10 })]);
    assert.equal(r.devolucoes.quantidade, 0);
    assert.equal(r.devolucoes.valor, null);
  });
});

describe('serieDiaria — mesma exclusão de devolvidos do gráfico diário', () => {
  test('dia com só um pedido devolvido soma zero no gráfico (não aparece com faturamento fantasma)', () => {
    const pedidos = [
      pedido({ valorTotal: 100, dataEfetiva: '2026-09-20T10:00:00Z' }),
      pedido({ valorTotal: 999, devolvido: true, dataEfetiva: '2026-09-20T11:00:00Z' }),
    ];
    const serie = serieDiaria(pedidos);
    assert.equal(serie.length, 1);
    assert.equal(serie[0].faturamento, 100, 'o pedido devolvido (999) não pode aparecer somado no dia');
  });
});
