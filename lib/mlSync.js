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
const { diaBRT, inicioDoDiaBRTDeString } = require('./periodo');

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

async function importarPedidoInterno(conta, orderId, accessToken) {
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

  // Pagamentos: detalhe COMPLETO de order.payments[] (pode ser mais de um).
  // ml_pedidos.pagamento_* (acima) continua só com o resumo do primeiro
  // pagamento, usado por lib/resultadoVenda.js — esta tabela é auditoria/
  // consulta detalhada, sem mudar essa fonte de cálculo. Mesmo padrão de
  // substituir tudo ao ressincronizar, igual aos itens.
  await pool.query('DELETE FROM ml_pedido_pagamentos WHERE pedido_id = $1', [pedidoId]);
  for (const pg of order.payments || []) {
    await pool.query(
      `INSERT INTO ml_pedido_pagamentos (
         pedido_id, ml_payment_id, status, status_detail, payment_type, payment_method_id,
         transaction_amount, taxes_amount, shipping_cost, marketplace_fee, installments,
         date_approved, date_created, raw_pagamento
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        pedidoId,
        pg.id || null,
        pg.status || null,
        pg.status_detail || null,
        pg.payment_type || null,
        pg.payment_method_id || null,
        num(pg.transaction_amount),
        num(pg.taxes_amount),
        num(pg.shipping_cost),
        num(pg.marketplace_fee),
        Number.isInteger(pg.installments) ? pg.installments : null,
        pg.date_approved || null,
        pg.date_created || null,
        JSON.stringify(pg),
      ]
    );
  }

  return pedidoId;
}

// Trava por pedido: a sincronização periódica e o webhook de notificação em
// tempo real podem tentar importar o MESMO pedido ao mesmo tempo (ex: o
// Mercado Livre manda notificação de "pago" bem na hora em que a
// sincronização manual também chega nesse pedido). Sem isso, as duas
// chamadas concorrentes poderiam se atropelar no DELETE+INSERT dos itens do
// pedido. Enfileira por pedido (não trava pedidos diferentes entre si).
const filaPorPedido = new Map();
function importarPedido(conta, orderId, accessToken) {
  const chave = conta.id + ':' + orderId;
  const anterior = filaPorPedido.get(chave) || Promise.resolve();
  const atual = anterior.then(
    () => importarPedidoInterno(conta, orderId, accessToken),
    () => importarPedidoInterno(conta, orderId, accessToken)
  );
  filaPorPedido.set(chave, atual.catch(() => {}));
  return atual;
}

// Usado pelo webhook (notificação em tempo real) — recebe o ml_user_id (dono
// da notificação) e o ID do pedido, encontra a conta correspondente já
// conectada neste ERP e importa exatamente como a sincronização manual faz.
async function importarPedidoPorNotificacao(mlUserId, orderId) {
  const { rows } = await pool.query('SELECT id FROM ml_contas WHERE ml_user_id = $1', [mlUserId]);
  if (!rows.length) return null; // notificação de uma conta que não está conectada aqui — ignora
  const conta = await getContaComTokenValido(rows[0].id);
  const accessToken = decrypt(conta.access_token_enc);
  return importarPedido(conta, orderId, accessToken);
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

// ============================================================
// Sincronização HISTÓRICA — importa TODOS os pedidos desde uma data
// específica (ex: 01/07/2026), diferente de sincronizarConta() acima, que
// só traz os últimos 30 dias. Processada dia a dia (fuso America/Sao_Paulo)
// para nunca esbarrar no limite de paginação da busca do Mercado Livre
// (a API não documenta um "scroll" para /orders/search — offsets muito
// altos não são confiáveis), e para poder retomar de onde parou se for
// interrompida, sem reprocessar tudo de novo.
const DIA_MS = 24 * 60 * 60 * 1000;

function formatarDataISO(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function proximoDiaStr(diaStr) {
  return formatarDataISO(new Date(inicioDoDiaBRTDeString(diaStr).getTime() + DIA_MS));
}

// Colunas DATE do Postgres voltam do driver `pg` como objeto Date (não como
// string 'YYYY-MM-DD') — importante normalizar antes de comparar com uma
// string, porque `'2026-07-01' <= new Date(...)` em JS NÃO compara datas
// (o lado esquerdo vira NaN na comparação, e a expressão dá sempre `false`,
// pulando o laço inteiro sem processar nenhum dia). Sempre comparar
// string-com-string.
function paraDataStr(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return formatarDataISO(new Date(v));
}

// Acha uma execução em andamento (mesma conta + mesmo "desde") para retomar,
// ou cria uma nova. Rápido (só banco) — usado pra responder logo no POST,
// antes do processamento (que pode levar bastante tempo) começar.
async function iniciarOuRetomarSyncHistorico(contaId, desdeStr) {
  const hojeStr = diaBRT(new Date());

  const { rows: existentes } = await pool.query(
    `SELECT * FROM ml_sync_historicos
     WHERE conta_ml_id = $1 AND desde = $2 AND status != 'concluido'
     ORDER BY iniciado_em DESC LIMIT 1`,
    [contaId, desdeStr]
  );
  if (existentes.length) {
    const { rows } = await pool.query(
      `UPDATE ml_sync_historicos SET status = 'em_andamento', atualizado_em = now() WHERE id = $1 RETURNING *`,
      [existentes[0].id]
    );
    return rows[0];
  }

  const { rows } = await pool.query(
    `INSERT INTO ml_sync_historicos (conta_ml_id, desde, ate_alvo, status)
     VALUES ($1, $2, $3, 'em_andamento') RETURNING *`,
    [contaId, desdeStr, hojeStr]
  );
  return rows[0];
}

async function buscarUltimoSyncHistorico(contaId, desdeStr) {
  const { rows } = await pool.query(
    `SELECT * FROM ml_sync_historicos WHERE conta_ml_id = $1 AND desde = $2 ORDER BY iniciado_em DESC LIMIT 1`,
    [contaId, desdeStr]
  );
  return rows[0] || null;
}

// Processamento de fato — pode levar dezenas de minutos numa conta com
// muitos pedidos. Chamada em segundo plano (depois da resposta HTTP já ter
// sido enviada), com progresso salvo a cada dia concluído.
async function processarSyncHistorico(contaId, desdeStr) {
  const execucao = await iniciarOuRetomarSyncHistorico(contaId, desdeStr);

  const ateAlvoStr = paraDataStr(execucao.ate_alvo);
  let diaAtual = execucao.janela_concluida_ate
    ? proximoDiaStr(paraDataStr(execucao.janela_concluida_ate))
    : desdeStr;
  let totalEncontrados = execucao.total_encontrados;
  let totalImportados = execucao.total_importados;
  let erros = Array.isArray(execucao.erros) ? execucao.erros : [];

  try {
    while (diaAtual <= ateAlvoStr) {
      const conta = await getContaComTokenValido(contaId); // renova o token se estiver perto de vencer
      const accessToken = decrypt(conta.access_token_enc);

      const desdeDia = inicioDoDiaBRTDeString(diaAtual);
      const ateDia = new Date(desdeDia.getTime() + DIA_MS);
      const filtroData = `&order.date_created.from=${encodeURIComponent(isoComOffset(desdeDia))}&order.date_created.to=${encodeURIComponent(isoComOffset(ateDia))}`;

      const limit = 50;
      let offset = 0;
      let totalDia = 0;
      do {
        const search = await ml.apiGet(
          `/orders/search?seller=${conta.ml_user_id}&sort=date_desc&offset=${offset}&limit=${limit}${filtroData}`,
          accessToken
        );
        totalDia = search.paging ? search.paging.total : (search.results || []).length;
        totalEncontrados += (search.results || []).length;

        for (const resumo of search.results || []) {
          try {
            await importarPedido(conta, resumo.id, accessToken);
            totalImportados++;
          } catch (err) {
            erros.push({ orderId: resumo.id, dia: diaAtual, erro: err.message });
          }
        }
        offset += limit;
      } while (offset < totalDia);

      await pool.query(
        `UPDATE ml_sync_historicos SET
           janela_concluida_ate = $1, total_encontrados = $2, total_importados = $3, erros = $4, atualizado_em = now()
         WHERE id = $5`,
        [diaAtual, totalEncontrados, totalImportados, JSON.stringify(erros), execucao.id]
      );

      diaAtual = proximoDiaStr(diaAtual);
    }

    const { rows } = await pool.query(
      `UPDATE ml_sync_historicos SET status = 'concluido', finalizado_em = now(), atualizado_em = now() WHERE id = $1 RETURNING *`,
      [execucao.id]
    );
    return rows[0];
  } catch (err) {
    erros.push({ dia: diaAtual, erro: 'Sincronização histórica interrompida: ' + err.message });
    await pool.query(
      `UPDATE ml_sync_historicos SET status = 'erro', erros = $1, atualizado_em = now() WHERE id = $2`,
      [JSON.stringify(erros), execucao.id]
    );
    throw err;
  }
}

module.exports = {
  sincronizarConta,
  getContaComTokenValido,
  importarPedidoPorNotificacao,
  iniciarOuRetomarSyncHistorico,
  buscarUltimoSyncHistorico,
  processarSyncHistorico,
};
