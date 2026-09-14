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
// Fase 2b (14/09/2026, pedido explícito do usuário: "quero igual ao
// mercado livre, mas com as taxas e comissões da shopee") — cada lote
// também busca o REPASSE real de cada pedido (comissão/tarifas —
// payment/get_escrow_detail_batch, ver lib/shopee.js#obterDetalhesRepasse),
// numa chamada separada de get_order_detail porque a Shopee não devolve
// esse dado junto do pedido. Um pedido cujo repasse a Shopee ainda não
// processou fica com a comissão NULL (nunca inventada) até um próximo
// ciclo de sincronização buscar de novo — ver
// orderSnsPendentesDeRepasse/buscarRepassesDoLote abaixo.
const pool = require('../db/pool');
const { decrypt } = require('./shopeeCrypto');
const shopee = require('./shopee');
const { renovarTokenDaConta } = require('./shopeeTokenScheduler');
// SEMPRE ler as credenciais por aqui, nunca process.env direto — ver
// lib/shopeeCredenciais.js (o "Wrong sign." dos 4 erros da primeira
// sincronização real, 14/09/2026, foi porque este arquivo lia
// process.env.SHOPEE_PARTNER_KEY sem o trim que já existia em
// routes/shopee.js, então a assinatura HMAC saía errada).
const { credencialShopee } = require('./shopeeCredenciais');

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

// Diagnóstico temporário (14/09/2026): o resultado da sincronização só
// devolve `erro.message` pro frontend (que só mostra a CONTAGEM de erros no
// toast, nunca o texto) — pra descobrir o motivo real do primeiro teste ao
// vivo falhar nas 4 janelas, este log imprime no console do servidor (nunca
// no navegador do usuário) a mensagem completa E, quando a Shopee devolveu
// um corpo de resposta com o erro (err.data — ex.: {error, message,
// request_id}), esse corpo também, mascarando qualquer coisa que pareça
// token/segredo por segurança. Mesmo padrão de diagnóstico não-destrutivo já
// usado (e depois removido) para o bug do "wrong sign".
function logErroSincronizacao(contexto, err) {
  const detalhe = err && err.data ? JSON.stringify(err.data) : '(sem corpo de resposta da Shopee)';
  console.error(`[Shopee][sincronizar][diagnóstico] ${contexto} — ${err && err.message}. Resposta da Shopee: ${detalhe}`);
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
      partnerId: credencialShopee('SHOPEE_PARTNER_ID'),
      partnerKey: credencialShopee('SHOPEE_PARTNER_KEY'),
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
// `repasse` (Fase 2b) é o item de payment/get_escrow_detail_batch deste
// pedido, quando a Shopee já devolveu um (null quando ainda não tem —
// nunca bloqueia a importação do pedido em si, ver comentário no topo do
// arquivo). Os 5 campos de comissão/repasse usam COALESCE no UPDATE: um
// ciclo em que a Shopee ainda não devolveu repasse pra este pedido NUNCA
// apaga um valor real já capturado num ciclo anterior — só um repasse novo
// (não nulo) substitui o anterior.
async function importarPedidoInterno(conta, order, repasse) {
  const itens = order.item_list || [];
  const income = repasse && repasse.order_income;

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
    income ? num(income.commission_fee) : null,
    income ? num(income.seller_transaction_fee) : null,
    income ? num(income.service_fee) : null,
    income ? num(income.escrow_amount) : null,
    repasse ? JSON.stringify(repasse) : null,
  ];

  const { rows } = await pool.query(
    `INSERT INTO shopee_pedidos (
       conta_shopee_id, order_sn, order_status, data_criacao, data_atualizacao,
       comprador_user_id, comprador_username, valor_total, moeda,
       metodo_pagamento, transportadora, frete_estimado, frete_real,
       raw_pedido,
       comissao_venda, taxa_transacao_pagamento, taxa_servico, valor_repasse, raw_repasse,
       atualizado_em
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
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
       comissao_venda = COALESCE(EXCLUDED.comissao_venda, shopee_pedidos.comissao_venda),
       taxa_transacao_pagamento = COALESCE(EXCLUDED.taxa_transacao_pagamento, shopee_pedidos.taxa_transacao_pagamento),
       taxa_servico = COALESCE(EXCLUDED.taxa_servico, shopee_pedidos.taxa_servico),
       valor_repasse = COALESCE(EXCLUDED.valor_repasse, shopee_pedidos.valor_repasse),
       raw_repasse = COALESCE(EXCLUDED.raw_repasse, shopee_pedidos.raw_repasse),
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

// Fase 2b: quais order_sn deste lote AINDA precisam de repasse (nunca
// pedidos que já têm comissão capturada num ciclo anterior — evita gastar
// chamada à Shopee de novo pra pedido antigo já resolvido, já que o ciclo
// automático roda a cada poucos minutos sobre os últimos dias). Um pedido
// que ainda não existe no banco (primeira vez que a Shopee manda ele)
// sempre entra na lista — não tem como já ter comissão capturada.
async function orderSnsPendentesDeRepasse(conta, orderSnList) {
  if (!orderSnList.length) return orderSnList;
  const { rows } = await pool.query(
    `SELECT order_sn FROM shopee_pedidos WHERE conta_shopee_id = $1 AND order_sn = ANY($2::text[]) AND comissao_venda IS NOT NULL`,
    [conta.id, orderSnList]
  );
  const jaTem = new Set(rows.map((r) => r.order_sn));
  return orderSnList.filter((sn) => !jaTem.has(sn));
}

// Fase 2b: busca o repasse (comissão/tarifas reais) de um lote de order_sn —
// devolve um Map order_sn -> item de escrow_detail. Uma falha nesta chamada
// NUNCA impede a importação dos pedidos em si (ver importarPedidosDoLote
// abaixo) — só a comissão fica pendente pra este ciclo, tentada de novo no
// próximo (mesmo espírito de resiliência já usado pra get_order_list/
// get_order_detail).
async function buscarRepassesDoLote(conta, accessToken, orderSnList) {
  const mapa = new Map();
  if (!orderSnList.length) return mapa;
  try {
    const resp = await shopee.obterDetalhesRepasse({
      partnerId: credencialShopee('SHOPEE_PARTNER_ID'),
      partnerKey: credencialShopee('SHOPEE_PARTNER_KEY'),
      accessToken,
      shopId: conta.shopee_shop_id,
      orderSnList,
    });
    // Defensivo quanto ao formato exato do envelope de resposta (primeira
    // chamada deste projeto a este endpoint — ver comentário no topo do
    // arquivo): a documentação cruzada usada indica que `response` já é a
    // lista de itens diretamente, mas alguns endpoints da Shopee embrulham
    // a lista num campo nomeado — os dois formatos são aceitos aqui sem
    // quebrar a sincronização caso o formato real seja o segundo.
    const lista = Array.isArray(resp.response)
      ? resp.response
      : (resp.response && Array.isArray(resp.response.escrow_detail_batch_list) ? resp.response.escrow_detail_batch_list : []);
    for (const item of lista) {
      const detalhe = item && item.escrow_detail;
      if (detalhe && detalhe.order_sn) mapa.set(detalhe.order_sn, detalhe);
    }
  } catch (err) {
    logErroSincronizacao(`lote de ${orderSnList.length} pedido(s) (get_escrow_detail_batch)`, err);
  }
  return mapa;
}

async function importarPedidosDoLote(conta, accessToken, orderSnList) {
  const resp = await shopee.obterDetalhesPedidos({
    partnerId: credencialShopee('SHOPEE_PARTNER_ID'),
    partnerKey: credencialShopee('SHOPEE_PARTNER_KEY'),
    accessToken,
    shopId: conta.shopee_shop_id,
    orderSnList,
  });
  const pedidos = (resp.response && resp.response.order_list) || [];

  // Fase 2b: busca o repasse só dos pedidos que ainda não têm comissão
  // capturada — ver orderSnsPendentesDeRepasse acima.
  const pendentesDeRepasse = await orderSnsPendentesDeRepasse(conta, orderSnList);
  const repassesPorOrderSn = await buscarRepassesDoLote(conta, accessToken, pendentesDeRepasse);

  let importados = 0;
  for (const order of pedidos) {
    await importarPedidoInterno(conta, order, repassesPorOrderSn.get(order.order_sn) || null);
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
          logErroSincronizacao(`lote de ${lote.length} pedido(s), janela ${new Date(janelaInicio * 1000).toISOString()} a ${new Date(janelaFim * 1000).toISOString()} (get_order_detail)`, err);
          erros.push({ janelaDe: janelaInicio, janelaAte: janelaFim, erro: err.message });
        }
      }
    } catch (err) {
      logErroSincronizacao(`janela ${new Date(janelaInicio * 1000).toISOString()} a ${new Date(janelaFim * 1000).toISOString()} (get_order_list)`, err);
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
  // Fase 2b — exportadas só para o teste automatizado do repasse
  orderSnsPendentesDeRepasse,
  buscarRepassesDoLote,
};
