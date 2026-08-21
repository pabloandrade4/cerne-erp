// Sincronização de pedidos do Mercado Livre: busca os pedidos do vendedor,
// o detalhe de cada um, e os custos reais do envio — e grava tudo no banco
// sem duplicar (UPSERT por conta_ml_id + ml_order_id).
//
// Regra importante (pedida pelo usuário): nunca inventar valor. Quando a API
// não retorna um campo, ele fica NULL no banco (e o front-end mostra
// "indisponível"), nunca um número calculado/estimado.
const pool = require('../db/pool');
const { encrypt, decrypt } = require('./crypto');
const ml = require('./mercadolivre');

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // renova se faltar menos de 5min pro vencimento

async function getContaComTokenValido(contaId) {
  const { rows } = await pool.query('SELECT * FROM ml_contas WHERE id = $1', [contaId]);
  if (!rows.length) {
    const err = new Error('Conta do Mercado Livre não encontrada.');
    err.status = 404;
    throw err;
  }
  let conta = rows[0];
  const expiresAt = new Date(conta.token_expires_at).getTime();

  if (expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
    try {
      const refreshTokenValue = decrypt(conta.refresh_token_enc);
      const tokenData = await ml.refreshAccessToken({
        clientId: process.env.ML_CLIENT_ID,
        clientSecret: process.env.ML_CLIENT_SECRET,
        refreshToken: refreshTokenValue,
      });
      const { rows: updated } = await pool.query(
        `UPDATE ml_contas
         SET access_token_enc = $1, refresh_token_enc = $2, token_expires_at = $3,
             status = 'ativa', ultimo_erro = NULL, updated_at = now()
         WHERE id = $4
         RETURNING *`,
        [
          encrypt(tokenData.access_token),
          encrypt(tokenData.refresh_token),
          new Date(Date.now() + tokenData.expires_in * 1000),
          contaId,
        ]
      );
      conta = updated[0];
    } catch (err) {
      await pool.query(
        `UPDATE ml_contas SET status = 'erro', ultimo_erro = $1, updated_at = now() WHERE id = $2`,
        [String(err.message || err).slice(0, 500), contaId]
      );
      const wrapped = new Error('Não foi possível renovar o token do Mercado Livre. A conexão precisa ser refeita.');
      wrapped.status = 401;
      throw wrapped;
    }
  }
  return conta;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function importarPedido(conta, orderId, accessToken) {
  const order = await ml.apiGet(`/orders/${orderId}`, accessToken);

  let envio = null;
  let custosEnvio = null;
  let freteComprador = null;
  let freteVendedor = null;

  if (order.shipping && order.shipping.id) {
    try {
      envio = await ml.apiGet(`/shipments/${order.shipping.id}`, accessToken);
    } catch (e) {
      envio = null; // status/logística do envio ficam indisponíveis para este pedido
    }
    try {
      custosEnvio = await ml.apiGet(`/shipments/${order.shipping.id}/costs`, accessToken);
      freteComprador = num(custosEnvio && custosEnvio.receiver && custosEnvio.receiver.cost);
      const senders = (custosEnvio && custosEnvio.senders) || [];
      const senderDaConta = senders.find((s) => String(s.id) === String(conta.ml_user_id));
      freteVendedor = num((senderDaConta || senders[0] || {}).cost);
    } catch (e) {
      custosEnvio = null; // frete comprador/vendedor ficam indisponíveis (nunca estimados)
    }
  }

  const pagamento = (order.payments && order.payments[0]) || null;

  const itens = order.order_items || [];
  const taxaVendaTotal = itens.some((it) => typeof it.sale_fee === 'number')
    ? itens.reduce((sum, it) => sum + (typeof it.sale_fee === 'number' ? it.sale_fee : 0), 0)
    : null;

  const values = [
    conta.id,
    orderId,
    order.pack_id || null,
    order.date_created || null,
    order.date_closed || null,
    order.status || null,
    order.status_detail || null,
    order.buyer ? order.buyer.id : null,
    order.buyer ? order.buyer.nickname : null,
    num(order.total_amount),
    order.currency_id || null,

    pagamento ? pagamento.id : null,
    pagamento ? pagamento.status : null,
    pagamento ? num(pagamento.taxes_amount) : null,
    pagamento ? num(pagamento.marketplace_fee) : null,
    pagamento ? pagamento.payment_type || pagamento.payment_method_id || null : null,

    order.shipping ? order.shipping.id : null,
    envio ? envio.status : null,
    envio && envio.logistic ? envio.logistic.mode : null,
    envio && envio.logistic ? envio.logistic.type : null,
    freteComprador,
    freteVendedor,

    taxaVendaTotal,

    JSON.stringify(order),
    envio ? JSON.stringify(envio) : null,
    custosEnvio ? JSON.stringify(custosEnvio) : null,
  ];

  const { rows } = await pool.query(
    `INSERT INTO ml_pedidos (
       conta_ml_id, ml_order_id, pack_id, data_criacao, data_fechamento, status, status_detail,
       comprador_id, comprador_nickname, valor_total, moeda,
       ml_payment_id, pagamento_status, pagamento_taxas, pagamento_taxa_marketplace, pagamento_metodo,
       ml_shipping_id, envio_status, envio_logistic_mode, envio_logistic_type,
       frete_comprador, frete_vendedor,
       taxa_venda_total,
       raw_pedido, raw_envio, raw_custos_envio, atualizado_em
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26, now())
     ON CONFLICT (conta_ml_id, ml_order_id) DO UPDATE SET
       pack_id = EXCLUDED.pack_id,
       data_criacao = EXCLUDED.data_criacao,
       data_fechamento = EXCLUDED.data_fechamento,
       status = EXCLUDED.status,
       status_detail = EXCLUDED.status_detail,
       comprador_id = EXCLUDED.comprador_id,
       comprador_nickname = EXCLUDED.comprador_nickname,
       valor_total = EXCLUDED.valor_total,
       moeda = EXCLUDED.moeda,
       ml_payment_id = EXCLUDED.ml_payment_id,
       pagamento_status = EXCLUDED.pagamento_status,
       pagamento_taxas = EXCLUDED.pagamento_taxas,
       pagamento_taxa_marketplace = EXCLUDED.pagamento_taxa_marketplace,
       pagamento_metodo = EXCLUDED.pagamento_metodo,
       ml_shipping_id = EXCLUDED.ml_shipping_id,
       envio_status = EXCLUDED.envio_status,
       envio_logistic_mode = EXCLUDED.envio_logistic_mode,
       envio_logistic_type = EXCLUDED.envio_logistic_type,
       frete_comprador = EXCLUDED.frete_comprador,
       frete_vendedor = EXCLUDED.frete_vendedor,
       taxa_venda_total = EXCLUDED.taxa_venda_total,
       raw_pedido = EXCLUDED.raw_pedido,
       raw_envio = EXCLUDED.raw_envio,
       raw_custos_envio = EXCLUDED.raw_custos_envio,
       atualizado_em = now()
     RETURNING id`,
    values
  );
  const pedidoId = rows[0].id;

  // Itens: substitui pelos itens atuais da API (evita sobras de sincronizações antigas)
  await pool.query('DELETE FROM ml_pedido_itens WHERE pedido_id = $1', [pedidoId]);
  for (const it of itens) {
    const unitPrice = num(it.unit_price);
    const fullUnitPrice = num(it.full_unit_price);
    const quantidade = num(it.quantity);
    await pool.query(
      `INSERT INTO ml_pedido_itens (
         pedido_id, ml_item_id, titulo, sku, variation_id, quantidade,
         preco_unitario, preco_unitario_original, valor_total_item, taxa_venda
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        pedidoId,
        it.item ? it.item.id : null,
        it.item ? it.item.title : null,
        it.item ? it.item.seller_sku || null : null,
        it.item ? it.item.variation_id || null : null,
        quantidade,
        unitPrice,
        fullUnitPrice,
        unitPrice != null && quantidade != null ? Math.round(unitPrice * quantidade * 100) / 100 : null,
        num(it.sale_fee),
      ]
    );
  }

  return pedidoId;
}

const DIAS_PADRAO_SINCRONIZACAO = 30;

// Formata no padrão exigido pelo filtro de data da API do Mercado Livre
// (ISO 8601 com offset), ex: 2026-07-22T00:00:00.000-00:00
function isoComOffset(date) {
  return date.toISOString().replace('Z', '-00:00');
}

async function sincronizarConta(contaId, { diasAtras = DIAS_PADRAO_SINCRONIZACAO } = {}) {
  const conta = await getContaComTokenValido(contaId);
  const accessToken = decrypt(conta.access_token_enc);

  const agora = new Date();
  const desde = new Date(agora.getTime() - diasAtras * 24 * 60 * 60 * 1000);
  const filtroData = `&order.date_created.from=${encodeURIComponent(isoComOffset(desde))}&order.date_created.to=${encodeURIComponent(isoComOffset(agora))}`;

  const limit = 50;
  let offset = 0;
  let total = null;
  let importados = 0;
  const erros = [];

  do {
    const search = await ml.apiGet(
      `/orders/search?seller=${conta.ml_user_id}&sort=date_desc&offset=${offset}&limit=${limit}${filtroData}`,
      accessToken
    );
    total = search.paging ? search.paging.total : (search.results || []).length;

    for (const resumo of search.results || []) {
      try {
        await importarPedido(conta, resumo.id, accessToken);
        importados++;
      } catch (err) {
        erros.push({ orderId: resumo.id, erro: err.message });
      }
    }
    offset += limit;
  } while (offset < total);

  await pool.query(
    `UPDATE ml_contas SET ultima_sincronizacao_em = now(), status = 'ativa', ultimo_erro = $1, updated_at = now() WHERE id = $2`,
    [erros.length ? `${erros.length} pedido(s) falharam ao importar.` : null, contaId]
  );

  return {
    total: total || 0,
    importados,
    erros,
    periodo: { desde: desde.toISOString(), ate: agora.toISOString(), dias: diasAtras },
  };
}

module.exports = { sincronizarConta, getContaComTokenValido };
