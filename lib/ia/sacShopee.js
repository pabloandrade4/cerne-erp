// Sincronização (só LEITURA) do agente "SAC Shopee" — 14/09/2026, pedido
// explícito do usuário. Busca Conversas do chat pós-venda e Devoluções da
// API da Shopee e grava cada uma em sac_atendimentos (ver
// lib/ia/sacStore.js) — NUNCA chama nenhum endpoint de escrita (enviar
// mensagem, confirmar/disputar devolução).
//
// IMPORTANTE (mesma honestidade já registrada em lib/shopee.js): esta é a
// PRIMEIRA sincronização deste projeto contra o Chat e as Devoluções da
// Shopee — os nomes de campo da resposta não puderam ser conferidos byte a
// byte contra a documentação oficial neste ambiente. Cada conversa/
// devolução é processada com try/catch própria; uma que não tiver os
// campos esperados é simplesmente pulada (nunca um atendimento com dado
// inventado) e o total de "puladas" aparece no resultado.
const shopee = require('../shopee');
const { decrypt } = require('../shopeeCrypto');
// lib/shopeeSync.js#getContaComTokenValido não é exportado (é um helper
// interno) — chama direto lib/shopeeTokenScheduler.js#renovarTokenDaConta,
// que é a mesma função que ele delega por baixo (ver lib/shopeeSync.js).
const { renovarTokenDaConta } = require('../shopeeTokenScheduler');
const { credencialShopee } = require('../shopeeCredenciais');
const sacStore = require('./sacStore');

async function getContaComTokenValido(contaId) {
  return renovarTokenDaConta(contaId, { forcar: false });
}

const LIMITE_CONVERSAS = 50;
const JANELA_DEVOLUCOES_DIAS = 30;

function credenciais(conta, accessToken) {
  return {
    partnerId: credencialShopee('SHOPEE_PARTNER_ID'),
    partnerKey: credencialShopee('SHOPEE_PARTNER_KEY'),
    accessToken,
    shopId: conta.shopee_shop_id,
  };
}

// A Shopee costuma devolver, na própria listagem de conversas, uma prévia
// da última mensagem (nome do campo varia entre versões da API — tenta os
// nomes mais comuns documentados por integradores; se nenhum bater, busca o
// texto na conversa completa como fallback).
function extrairUltimaMensagemDaLista(conversa) {
  const texto = conversa.latest_message_content?.text
    || conversa.latest_message_content?.content
    || conversa.last_message_content
    || null;
  const ts = conversa.latest_message_time || conversa.last_message_timestamp || null;
  return texto ? { texto, ts } : null;
}

async function sincronizarConversas({ empresaId, contaId, conta, accessToken }) {
  const resposta = await shopee.buscarConversas({ ...credenciais(conta, accessToken), pageSize: LIMITE_CONVERSAS });
  const corpo = resposta.response || resposta;
  const conversas = corpo.conversations || corpo.conversation_list || [];
  if (!conversas.length) return { processadas: 0, novos: 0, puladas: 0, idsNovos: [] };

  let novos = 0;
  let puladas = 0;
  let processadas = 0;
  const idsNovos = [];

  for (const conversa of conversas) {
    const conversationId = conversa.conversation_id || conversa.conversationId;
    if (!conversationId) { puladas++; continue; }

    let mensagem = extrairUltimaMensagemDaLista(conversa);
    if (!mensagem) {
      try {
        const msgResp = await shopee.buscarMensagensConversa({ ...credenciais(conta, accessToken), conversationId, pageSize: 5 });
        const msgCorpo = msgResp.response || msgResp;
        const mensagens = msgCorpo.messages || [];
        const doComprador = mensagens
          .filter((m) => (m.from_shop_id === undefined || m.from_shop_id === null) || String(m.from_shop_id) !== String(conta.shopee_shop_id))
          .sort((a, b) => new Date(b.created_timestamp || b.create_time) - new Date(a.created_timestamp || a.create_time));
        if (doComprador.length) {
          const ultima = doComprador[0];
          mensagem = { texto: ultima.content?.text || ultima.message || null, ts: ultima.created_timestamp || ultima.create_time || null };
        }
      } catch (err) {
        console.error(`[SAC Shopee][conversas] mensagens da conversa ${conversationId}: ${err.message}`);
      }
    }
    if (!mensagem || !mensagem.texto) { puladas++; continue; }
    processadas++;

    const clienteNome = conversa.to_name || conversa.buyer_username || null;
    const clienteId = conversa.to_id || conversa.buyer_user_id || null;
    const dataRecebido = mensagem.ts
      ? (Number(mensagem.ts) > 1e12 ? new Date(Number(mensagem.ts)) : new Date(Number(mensagem.ts) * 1000))
      : new Date();

    const { id, ehSituacaoNova } = await sacStore.upsertAtendimento(empresaId, 'shopee', contaId, {
      tipoOrigem: 'mensagem',
      idExterno: String(conversationId),
      pedidoRef: conversa.order_sn || conversa.last_order_id || null,
      sku: null,
      produtoTitulo: conversa.shop_message_hidden ? null : (conversa.latest_message_option?.product_name || null),
      clienteNome,
      clienteIdExterno: clienteId ? String(clienteId) : null,
      mensagemCliente: mensagem.texto,
      dataRecebido,
      raw: conversa,
    });
    if (ehSituacaoNova) { novos++; idsNovos.push(id); }
  }
  return { processadas, novos, puladas, idsNovos };
}

async function sincronizarDevolucoes({ empresaId, contaId, conta, accessToken }) {
  const agora = Math.floor(Date.now() / 1000);
  const desde = agora - JANELA_DEVOLUCOES_DIAS * 24 * 60 * 60;
  const resposta = await shopee.buscarDevolucoes({ ...credenciais(conta, accessToken), timeFrom: desde, timeTo: agora, pageSize: 50 });
  const corpo = resposta.response || resposta;
  const devolucoes = corpo.return || corpo.return_list || [];
  if (!devolucoes.length) return { processadas: 0, novos: 0, puladas: 0, idsNovos: [] };

  let novos = 0;
  let puladas = 0;
  const idsNovos = [];
  for (const dev of devolucoes) {
    const returnSn = dev.return_sn || dev.returnsn;
    if (!returnSn) { puladas++; continue; }

    let mensagemCliente = dev.text_reason || dev.reason || null;
    try {
      const detalheResp = await shopee.buscarDetalheDevolucao({ ...credenciais(conta, accessToken), returnSn });
      const detalhe = (detalheResp.response || detalheResp).return || detalheResp.response || {};
      mensagemCliente = detalhe.text_reason || detalhe.reason || mensagemCliente;
    } catch (err) {
      console.error(`[SAC Shopee][devoluções] detalhe de ${returnSn}: ${err.message}`);
    }
    if (!mensagemCliente) {
      mensagemCliente = `Devolução aberta — status: ${dev.status || 'não informado'} (sem motivo em texto disponível).`;
    }

    const { id, ehSituacaoNova } = await sacStore.upsertAtendimento(empresaId, 'shopee', contaId, {
      tipoOrigem: 'devolucao',
      idExterno: String(returnSn),
      pedidoRef: dev.order_sn || null,
      sku: null,
      produtoTitulo: dev.item?.[0]?.name || null,
      clienteNome: dev.buyer_username || null,
      clienteIdExterno: dev.buyer_user_id ? String(dev.buyer_user_id) : null,
      mensagemCliente,
      dataRecebido: dev.create_time ? new Date(Number(dev.create_time) * 1000) : new Date(),
      raw: dev,
    });
    if (ehSituacaoNova) { novos++; idsNovos.push(id); }
  }
  return { processadas: devolucoes.length, novos, puladas, idsNovos };
}

async function sincronizarContaShopee(contaId) {
  const conta = await getContaComTokenValido(contaId);
  const accessToken = decrypt(conta.access_token_enc);
  const contexto = { empresaId: conta.empresa_id, contaId: conta.id, conta, accessToken };

  const resultado = {};
  for (const [chave, fn] of Object.entries({
    conversas: sincronizarConversas,
    devolucoes: sincronizarDevolucoes,
  })) {
    try {
      resultado[chave] = await fn(contexto);
    } catch (err) {
      console.error(`[SAC Shopee][${chave}] conta ${contaId}: ${err.message}`);
      resultado[chave] = { processadas: 0, novos: 0, erro: err.message };
    }
  }
  return { empresaId: conta.empresa_id, contaId: conta.id, ...resultado };
}

module.exports = { sincronizarContaShopee };
