// Sincronização de pedidos da Shopee (Fase 1, 14/09/2026 — pedido explícito
// do usuário: "puxar os últimos 60 dias"). Mesmo princípio de nunca
// inventar valor do Mercado Livre (lib/mlSync.js): campo que a API não
// manda fica NULL no banco (nunca um número calculado/estimado), e o
// payload bruto de cada pedido fica salvo (raw_pedido) para auditoria.
//
// Particularidade da Shopee (diferente do Mercado Livre): get_order_list só
// aceita no máximo 15 dias entre time_from/time_to por chamada (limite
// documentado pela própria Shopee) — por isso "últimos 60 dias" é dividido
// aqui em janelas de 15 dias, uma atrás da outra. get_order_detail só
// aceita até 50 pedidos por chamada — os order_sn de cada janela são
// buscados em lotes de 50 (ver lib/shopee.js).
//
// IMPORTANTE (mesma honestidade já registrada em lib/shopee.js): esta é a
// PRIMEIRA sincronização de pedidos da Shopee deste projeto, ainda não
// confirmada contra pedidos reais desta conta — só depois da primeira
// sincronização em produção. O payload bruto (raw_pedido) garante que
// nenhum dado real se perde mesmo que algum campo normalizado precise de
// ajuste depois de ver a primeira sincronização de verdade.
//
// Fase 2 (ainda não construída, depende de ver os dados reais que a Shopee
// devolve pra esta conta): cálculo de margem/comissão/frete da Shopee, e
// os pedidos da Shopee entrando nas mesmas telas de Pedidos/Relatórios/
// Financeiro do Mercado Livre. Até lá, os pedidos da Shopee ficam só na
// sua própria listagem simples (GET /api/integracoes/shopee/:id/pedidos).
const pool = require('../db/pool');
const { decrypt } = require('./shopeeCrypto');
const shopee = require('./shopee');
const { renovarTokenDaConta } = require('./shopeeTokenScheduler');

const JANELA_DIAS = 15; // limite documentado da Shopee para get_order_list
const DIA_S = 24 * 60 * 60;
const LOTE_DETALHE = 50; // limite documentado da Shopee para get_order_detail
const DIAS_PADRAO_SINCRONIZACAO = 60;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function loteArray(arr, tamanho) {
  const lotes = [];
  for (let i = 0; i < arr.length; i += tamanho) lotes.push(arr.slice(i, i + tamanho));
  return lotes;
}

// Garante um access_token válido — reaproveita o mesmo mecanismo de
// renovação do ciclo automático (lib/shopeeTokenScheduler.js), sem duplicar
// a lógica de refresh. `forcar: false` só renova se estiver mesmo perto de
// vencer (mesma margem do ciclo automático), então na prática isto quase
// nunca gasta uma chamada extra à Shopee.
async function getContaComTokenValido(contaId) {
  return renovarTokenDaConta(contaId, { forcar: false });
}

// Busca TODOS os order_sn de uma janela (até 15 dias), paginando via cursor
// até a Shopee dizer `more: false`. `cursor` vazio ('') é a forma de pedir a
// primeira página — mesma convenção do parâmetro da Shopee.
async function listarOrderSnsDaJanela(conta, accessToken, timeFrom, timeTo) {
  const orderSns = [];
  let cursor = '';
  let more = true;
  let voltas = 0;
  while (more) {
    voltas++;
    if (voltas > 1000) break; // segurança: nunca loop infinito por engano de paginação
    const resp = await shopee.listarPedidos({
      partnerId: process.env.SHOPEE_PARTNER_ID,
      partnerKey: process.env.SHOPEE_PARTNER_KEY,
      accessToken,
      shopId: conta.shopee_shop_id,
      timeFrom,
      timeTo,
      cursor,
      pageSize: 100,
    });
    const resposta = resp.response || {};
    for (const o of resposta.order_list || []) {
      if (o.order_sn) orderSns.push(o.order_sn);
    }
    more = !!resposta.more;
    cursor = resposta.next_cursor || '';
    if (more && !cursor) break; // segurança: sem cursor pra continuar, para aqui (nunca repete a mesma página)
  }
  return orderSns;
}

// Grava (ou atualiza) UM pedido — mesmo padrão de upsert do Mercado Livre
// (lib/mlSync.js#importarPedidoInterno): nunca duplica (UNIQUE conta_shopee_id
// + order_sn), sempre substitui os itens pelos itens atuais da resposta.
async function importarPedidoInterno(conta, order) {
  const itens = order.item_list || [];

  const values = [
    conta.id,
    order.order_sn,
    order.order_status || null,
    order.create_time ? new Date(order.create_time * 1000) : null,
    order.update_time ? new Date(order.update_time * 1000) : null,
    order.buyer_user_id || null,
    order.buyer_username || null,
    num(order.total_amount),
    order.currency || null,
    order.payment_method || null,
    order.shipping_carrier || null,
    num(order.estimated_shipping_fee),
    num(order.actual_shipping_fee),
    JSON.stringify(order),
  ];

  const { rows } = await pool.query(
    `INSERT INTO shopee_pedidos (
       conta_shopee_id, order_sn, order_status, data_criacao, data_atualizacao,
       comprador_user_id, comprador_username, valor_total, moeda,
       metodo_pagamento, transportadora, frete_estimado, frete_real,
       raw_pedido, atualizado_em
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     ON CONFLICT (conta_shopee_id, order_sn) DO UPDATE SET
       order_status = EXCLUDED.order_status,
       data_criacao = EXCLUDED.data_criacao,
       data_atualizacao = EXCLUDED.data_atualizacao,
       comprador_user_id = EXCLUDED.comprador_user_id,
       comprador_username = EXCLUDED.comprador_username,
       valor_total = EXCLUDED.valor_total,
       moeda = EXCLUDED.moeda,
       metodo_pagamento = EXCLUDED.metodo_pagamento,
       transportadora = EXCLUDED.transportadora,
       frete_estimado = EXCLUDED.frete_estimado,
       frete_real = EXCLUDED.frete_real,
       raw_pedido = EXCLUDED.raw_pedido,
       atualizado_em = now()
     RETURNING id`,
    values
  );
  const pedidoId = rows[0].id;

  // Itens: substitui pelos itens atuais da resposta (evita sobras de
  // sincronizações antigas) — mesmo padrão de ml_pedido_itens.
  await pool.query('DELETE FROM shopee_pedido_itens WHERE pedido_id = $1', [pedidoId]);
  for (const it of itens) {
    const quantidade = num(it.model_quantity_purchased ?? it.quantity_purchased);
    const precoUnitario = num(it.model_discounted_price ?? it.model_original_price);
    await pool.query(
      `INSERT INTO shopee_pedido_itens (
         pedido_id, item_id, nome, sku, variacao_id, quantidade, preco_unitario, valor_total_item
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        pedidoId,
        it.item_id || null,
        it.item_name || null,
        it.model_sku || it.item_sku || null,
        it.model_id || null,
        quantidade,
        precoUnitario,
        precoUnitario != null && quantidade != null ? Math.round(precoUnitario * quantidade * 100) / 100 : null,
      ]
    );
  }
  return pedidoId;
}

async function importarPedidosDoLote(conta, accessToken, orderSnList) {
  const resp = await shopee.obterDetalhesPedidos({
    partnerId: process.env.SHOPEE_PARTNER_ID,
    partnerKey: process.env.SHOPEE_PARTNER_KEY,
    accessToken,
    shopId: conta.shopee_shop_id,
    orderSnList,
  });
  const pedidos = (resp.response && resp.response.order_list) || [];
  let importados = 0;
  for (const order of pedidos) {
    await importarPedidoInterno(conta, order);
    importados++;
  }
  return importados;
}

// Sincroniza UMA loja: busca os últimos `diasAtras` dias (padrão 60),
// dividido em janelas de 15 dias, cada uma com seus order_sn buscados em
// detalhe em lotes de 50. Uma janela ou lote que falhar não impede os
// demais (mesma filosofia de resiliência já usada em lib/ia/dailyCiclo.js e
// lib/adsScheduler.js) — fica registrado em `erros`.
async function sincronizarConta(contaId, { diasAtras = DIAS_PADRAO_SINCRONIZACAO } = {}) {
  const conta = await getContaComTokenValido(contaId);
  const accessToken = decrypt(conta.access_token_enc);

  const agoraS = Math.floor(Date.now() / 1000);
  const desdeS = agoraS - diasAtras * DIA_S;

  let importados = 0;
  let totalEncontrados = 0;
  const erros = [];

  let janelaInicio = desdeS;
  while (janelaInicio < agoraS) {
    const janelaFim = Math.min(janelaInicio + JANELA_DIAS * DIA_S, agoraS);
    try {
      const orderSns = await listarOrderSnsDaJanela(conta, accessToken, janelaInicio, janelaFim);
      totalEncontrados += orderSns.length;
      for (const lote of loteArray(orderSns, LOTE_DETALHE)) {
        try {
          importados += await importarPedidosDoLote(conta, accessToken, lote);
        } catch (err) {
          erros.push({ janelaDe: janelaInicio, janelaAte: janelaFim, erro: err.message });
        }
      }
    } catch (err) {
      erros.push({ janelaDe: janelaInicio, janelaAte: janelaFim, erro: err.message });
    }
    janelaInicio = janelaFim;
  }

  await pool.query(
    `UPDATE shopee_contas SET ultima_sincronizacao_em = now(), status = 'ativa', ultimo_erro = $1, updated_at = now() WHERE id = $2`,
    [erros.length ? `${erros.length} janela(s)/lote(s) falharam ao importar.` : null, contaId]
  );

  return {
    totalEncontrados,
    importados,
    erros,
    periodo: { dias: diasAtras },
  };
}

module.exports = {
  sincronizarConta,
  // exportadas só para teste automatizado (evita bater na API de verdade
  // pra testar a matemática de janelas/lotes) — mesmo padrão de lib/mlSync.js
  importarPedidoInterno,
  loteArray,
};
