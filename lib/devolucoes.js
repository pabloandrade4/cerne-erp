// Devoluções (separadas de Cancelamento) — 26/09/2026, pedido explícito do
// usuário: entender "oque é devolção e oque é cancelamento de pedido".
// Só LEITURA — nunca aceita, recusa ou responde uma devolução, só detecta e
// classifica pra lib/relatorioVendas.js poder tirar do faturamento real
// quando o reembolso é confirmado (ver comentário grande em db/schema.sql,
// tabela pedido_devolucoes).
//
// Mercado Livre: reaproveita EXATAMENTE o mesmo endpoint de reclamações já
// usado pelo SAC (lib/mercadolivre.js#buscarReclamacoes) — nenhuma chamada
// nova. A diferença é o FILTRO: aqui só entra `type === 'return'` (devolução
// formal); outros tipos (mediations/cancel_purchase/cancel_sale) continuam
// só no SAC, sem afetar nenhum número financeiro.
//
// IMPORTANTE (mesma honestidade de sempre neste projeto): os campos usados
// pra saber se um reembolso foi CONFIRMADO (resolution.reason, coverages)
// vieram da documentação pública consultada em 23-26/09/2026, nunca
// confirmados contra uma devolução real desta conta — por isso a
// classificação abaixo é conservadora (só marca 'confirmada' quando o
// texto da resolução menciona reembolso claramente; qualquer coisa que não
// bate com o esperado fica 'aberta', nunca vira 'confirmada' no escuro).
const pool = require('../db/pool');
const ml = require('./mercadolivre');
const { decrypt } = require('./crypto');
const { getContaComTokenValido } = require('./mlSync');
const shopee = require('./shopee');
const { decrypt: decryptShopee } = require('./shopeeCrypto');
const { renovarTokenDaConta } = require('./shopeeTokenScheduler');
const { credencialShopee } = require('./shopeeCredenciais');

const JANELA_DEVOLUCOES_SHOPEE_DIAS = 60; // limite documentado da própria API (create_time_from/to)

function toNum(v) { return (v === null || v === undefined || v === '') ? null : Number(v); }

// ---- classificação Mercado Livre ----
// Usa só o que a própria API devolveu (nunca inventa um valor/; ver
// cabeçalho do arquivo sobre a incerteza dos nomes de campo).
function classificarClaimMercadoLivre(c) {
  const status = c.status; // 'opened' | 'closed' (documentação pública)
  if (status !== 'closed') {
    return { status: 'aberta', valorReembolsado: null, dataConclusao: null };
  }
  const resolucaoTexto = JSON.stringify(c.resolution || {}).toLowerCase();
  const teveReembolso = /refund/.test(resolucaoTexto);
  let valorReembolsado = null;
  const coverages = (c.resolution && Array.isArray(c.resolution.coverages)) ? c.resolution.coverages : null;
  if (coverages && coverages.length) {
    const soma = coverages.reduce((s, cov) => s + (toNum(cov.amount) || 0), 0);
    if (soma > 0) valorReembolsado = Math.round(soma * 100) / 100;
  }
  return {
    status: teveReembolso ? 'confirmada' : 'negada_ou_cancelada',
    valorReembolsado,
    dataConclusao: c.last_updated || c.date_closed || null,
  };
}

async function sincronizarDevolucoesMercadoLivreConta(contaId) {
  const conta = await getContaComTokenValido(contaId);
  const accessToken = decrypt(conta.access_token_enc);
  const resposta = await ml.buscarReclamacoes({ accessToken, sellerId: conta.ml_user_id });
  const claims = (resposta && (resposta.data || resposta.results)) || [];
  const devolucoes = claims.filter((c) => c.type === 'return');
  if (!devolucoes.length) return { processadas: 0, verificadas: claims.length, gravadas: 0 };

  let gravadas = 0;
  for (const c of devolucoes) {
    try {
      const { status, valorReembolsado, dataConclusao } = classificarClaimMercadoLivre(c);
      await pool.query(
        `INSERT INTO pedido_devolucoes (
           empresa_id, marketplace, conta_id, id_externo, pedido_ref, tipo,
           status, motivo, valor_reembolsado, data_criacao, data_conclusao, raw, sincronizado_em
         ) VALUES ($1,'mercado_livre',$2,$3,$4,'return',$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (empresa_id, marketplace, id_externo) DO UPDATE SET
           status = EXCLUDED.status, motivo = EXCLUDED.motivo,
           valor_reembolsado = COALESCE(EXCLUDED.valor_reembolsado, pedido_devolucoes.valor_reembolsado),
           data_conclusao = COALESCE(EXCLUDED.data_conclusao, pedido_devolucoes.data_conclusao),
           raw = EXCLUDED.raw, sincronizado_em = now(), updated_at = now()`,
        [
          conta.empresa_id, conta.id, String(c.id), c.resource_id ? String(c.resource_id) : null,
          status, `Devolução — motivo: ${c.reason_id || 'não informado'}, etapa: ${c.stage || 'não informada'}`,
          valorReembolsado, c.date_created || null, dataConclusao, JSON.stringify(c),
        ]
      );
      gravadas++;
    } catch (err) {
      console.error(`[Devoluções][Mercado Livre] claim ${c.id}: ${err.message}`);
    }
  }
  return { processadas: devolucoes.length, verificadas: claims.length, gravadas };
}

// ---- classificação Shopee ----
function classificarDevolucaoShopee(dev) {
  const status = dev.status; // ver lib/ia/sacShopee.js — mesmo campo já usado pro SAC
  if (status === 'COMPLETED') {
    return { status: 'confirmada', valorReembolsado: toNum(dev.refund_amount), dataConclusao: null };
  }
  if (status === 'CANCELLED') {
    return { status: 'negada_ou_cancelada', valorReembolsado: null, dataConclusao: null };
  }
  return { status: 'aberta', valorReembolsado: null, dataConclusao: null };
}

async function sincronizarDevolucoesShopeeConta(contaId) {
  const conta = await renovarTokenDaConta(contaId, { forcar: false });
  const accessToken = decryptShopee(conta.access_token_enc);
  const agora = Math.floor(Date.now() / 1000);
  const desde = agora - JANELA_DEVOLUCOES_SHOPEE_DIAS * 24 * 60 * 60;
  const resposta = await shopee.buscarDevolucoes({
    partnerId: credencialShopee('SHOPEE_PARTNER_ID'),
    partnerKey: credencialShopee('SHOPEE_PARTNER_KEY'),
    accessToken, shopId: conta.shopee_shop_id,
    timeFrom: desde, timeTo: agora, pageSize: 50,
  });
  const corpo = resposta.response || resposta;
  const devolucoes = corpo.return || corpo.return_list || [];
  if (!devolucoes.length) return { processadas: 0, verificadas: 0, gravadas: 0 };

  let gravadas = 0;
  for (const dev of devolucoes) {
    const returnSn = dev.return_sn || dev.returnsn;
    if (!returnSn) continue;
    try {
      const { status, valorReembolsado, dataConclusao } = classificarDevolucaoShopee(dev);
      await pool.query(
        `INSERT INTO pedido_devolucoes (
           empresa_id, marketplace, conta_id, id_externo, pedido_ref, tipo,
           status, motivo, valor_reembolsado, data_criacao, data_conclusao, raw, sincronizado_em
         ) VALUES ($1,'shopee',$2,$3,$4,'return',$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (empresa_id, marketplace, id_externo) DO UPDATE SET
           status = EXCLUDED.status, motivo = EXCLUDED.motivo,
           valor_reembolsado = COALESCE(EXCLUDED.valor_reembolsado, pedido_devolucoes.valor_reembolsado),
           data_conclusao = COALESCE(EXCLUDED.data_conclusao, pedido_devolucoes.data_conclusao),
           raw = EXCLUDED.raw, sincronizado_em = now(), updated_at = now()`,
        [
          conta.empresa_id, conta.id, String(returnSn), dev.order_sn || null,
          status, dev.text_reason || dev.reason || `Devolução — status: ${dev.status || 'não informado'}`,
          valorReembolsado, dev.create_time ? new Date(Number(dev.create_time) * 1000) : null, dataConclusao, JSON.stringify(dev),
        ]
      );
      gravadas++;
    } catch (err) {
      console.error(`[Devoluções][Shopee] devolução ${returnSn}: ${err.message}`);
    }
  }
  return { processadas: devolucoes.length, verificadas: devolucoes.length, gravadas };
}

// ---- orquestração por empresa (mesmo padrão de lib/ia/sacCiclo.js) ----
async function executarCicloDevolucoesEmpresa(empresaId) {
  const [contasMl, contasShopee] = await Promise.all([
    pool.query("SELECT id FROM ml_contas WHERE empresa_id = $1 AND status = 'ativa' ORDER BY id", [empresaId]),
    pool.query("SELECT id FROM shopee_contas WHERE empresa_id = $1 AND status = 'ativa' ORDER BY id", [empresaId]),
  ]);

  let gravadas = 0;
  const erros = [];
  for (const conta of contasMl.rows) {
    try { gravadas += (await sincronizarDevolucoesMercadoLivreConta(conta.id)).gravadas; }
    catch (err) { console.error(`[Devoluções][ciclo] conta ML ${conta.id}: ${err.message}`); erros.push({ marketplace: 'mercado_livre', contaId: conta.id, erro: err.message }); }
  }
  for (const conta of contasShopee.rows) {
    try { gravadas += (await sincronizarDevolucoesShopeeConta(conta.id)).gravadas; }
    catch (err) { console.error(`[Devoluções][ciclo] conta Shopee ${conta.id}: ${err.message}`); erros.push({ marketplace: 'shopee', contaId: conta.id, erro: err.message }); }
  }
  return { empresaId, contasProcessadas: contasMl.rows.length + contasShopee.rows.length, devolucoesGravadas: gravadas, erros };
}

async function executarCicloDevolucoes() {
  const { rows: empresas } = await pool.query('SELECT id FROM empresas WHERE ativo = TRUE ORDER BY id');
  const resultados = await Promise.allSettled(empresas.map((e) => executarCicloDevolucoesEmpresa(e.id)));
  const comErro = [];
  let devolucoesGravadas = 0;
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      const erro = String((r.reason && r.reason.message) || r.reason);
      comErro.push({ empresaId: empresas[i].id, erro });
      console.error(`[Devoluções][scheduler] empresa ${empresas[i].id} falhou: ${erro}`);
    } else {
      devolucoesGravadas += r.value.devolucoesGravadas || 0;
    }
  });
  return { empresasProcessadas: empresas.length, devolucoesGravadas, comErro };
}

module.exports = {
  sincronizarDevolucoesMercadoLivreConta,
  sincronizarDevolucoesShopeeConta,
  executarCicloDevolucoesEmpresa,
  executarCicloDevolucoes,
  classificarClaimMercadoLivre,
  classificarDevolucaoShopee,
};
