// Sincronização (só LEITURA) do agente "SAC Mercado Livre" — 14/09/2026,
// pedido explícito do usuário. Busca Perguntas (pré-venda), Mensagens
// pós-venda e Reclamações/devoluções da API do Mercado Livre e grava cada
// uma em sac_atendimentos (ver lib/ia/sacStore.js) — NUNCA chama nenhum
// endpoint de escrita (responder pergunta, enviar mensagem, etc.).
//
// Cada uma das 3 fontes roda isolada (try/catch própria) — se uma falhar
// (ex.: endpoint rejeitado, permissão faltando), as outras duas continuam
// normalmente e o erro aparece no resultado devolvido, nunca um atendimento
// inventado no lugar (regra 3 do pedido do usuário).
const pool = require('../../db/pool');
const ml = require('../mercadolivre');
const { decrypt } = require('../crypto');
const { getContaComTokenValido } = require('../mlSync');
const sacStore = require('./sacStore');

const MULTIGET_CHUNK = 20;
const LIMITE_PERGUNTAS = 50;
const LIMITE_RECLAMACOES = 50;
const LIMITE_PEDIDOS_PARA_MENSAGENS = 30; // pedidos mais recentes por conta, evita N chamadas demais por ciclo

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function buscarTitulosESkus(accessToken, itemIds) {
  const mapa = new Map();
  const idsUnicos = [...new Set(itemIds.filter(Boolean))];
  if (!idsUnicos.length) return mapa;
  const lotes = chunk(idsUnicos, MULTIGET_CHUNK);
  const respostas = await Promise.allSettled(
    lotes.map((lote) => ml.apiGet(`/items?ids=${lote.join(',')}&attributes=id,title,seller_custom_field,attributes`, accessToken))
  );
  respostas.forEach((r) => {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
    r.value.forEach((entry) => {
      const item = entry.body || entry;
      if (!item || !item.id) return;
      const skuAttr = (item.attributes || []).find((a) => a.id === 'SELLER_SKU');
      mapa.set(item.id, {
        titulo: item.title || null,
        sku: (skuAttr && skuAttr.value_name) || item.seller_custom_field || null,
      });
    });
  });
  return mapa;
}

// Perguntas feitas no anúncio (antes da compra). Busca as não respondidas
// primeiro (é o que importa pra caixa de entrada) — respondidas antigas não
// precisam voltar a cada ciclo.
async function sincronizarPerguntas({ empresaId, contaId, accessToken, sellerId }) {
  const resposta = await ml.buscarPerguntas({ accessToken, sellerId, status: 'UNANSWERED', limit: LIMITE_PERGUNTAS });
  const perguntas = (resposta && resposta.questions) || [];
  if (!perguntas.length) return { processadas: 0, novos: 0, idsNovos: [] };

  const itemIds = perguntas.map((p) => p.item_id).filter(Boolean);
  const infoPorItem = await buscarTitulosESkus(accessToken, itemIds);

  let novos = 0;
  const idsNovos = [];
  for (const p of perguntas) {
    const info = infoPorItem.get(p.item_id) || {};
    const { id, ehSituacaoNova } = await sacStore.upsertAtendimento(empresaId, 'mercado_livre', contaId, {
      tipoOrigem: 'pergunta',
      idExterno: String(p.id),
      pedidoRef: null,
      sku: info.sku || null,
      produtoTitulo: info.titulo || null,
      clienteNome: null, // a API de perguntas não devolve o nome do comprador — nunca inventado
      clienteIdExterno: p.from && p.from.id ? String(p.from.id) : null,
      mensagemCliente: p.text || '(pergunta sem texto)',
      dataRecebido: p.date_created || new Date().toISOString(),
      raw: p,
    });
    if (ehSituacaoNova) { novos++; idsNovos.push(id); }
  }
  return { processadas: perguntas.length, novos, idsNovos };
}

// Mensagens pós-venda — parte dos pedidos já sincronizados em ml_pedidos
// (lib/mlSync.js), que já tem pack_id + dados do comprador. Só olha os
// pedidos mais recentes da conta (LIMITE_PEDIDOS_PARA_MENSAGENS) pra não
// gastar uma chamada por pedido a cada ciclo.
async function sincronizarMensagensPosVenda({ empresaId, contaId, accessToken, sellerId }) {
  const { rows: pedidos } = await pool.query(
    `SELECT pack_id, ml_order_id, comprador_nickname, comprador_id FROM (
       SELECT DISTINCT ON (pack_id) pack_id, ml_order_id, comprador_nickname, comprador_id, data_criacao
         FROM ml_pedidos
        WHERE conta_ml_id = $1 AND pack_id IS NOT NULL
        ORDER BY pack_id, data_criacao DESC
     ) mais_recente_por_pack
     ORDER BY data_criacao DESC
     LIMIT $2`,
    [contaId, LIMITE_PEDIDOS_PARA_MENSAGENS]
  );
  if (!pedidos.length) return { processadas: 0, novos: 0, idsNovos: [] };

  let processadas = 0;
  let novos = 0;
  const idsNovos = [];
  for (const pedido of pedidos) {
    try {
      const resposta = await ml.buscarMensagensPosVenda({ accessToken, packId: pedido.pack_id, sellerId });
      const mensagens = (resposta && resposta.messages) || [];
      if (!mensagens.length) continue;
      // mais recente primeiro; pega a última mensagem que veio do
      // comprador (nunca uma mensagem que o próprio vendedor mandou)
      const doComprador = mensagens
        .filter((m) => m.from && String(m.from.user_id) !== String(sellerId))
        .sort((a, b) => new Date(b.message_date && b.message_date.created) - new Date(a.message_date && a.message_date.created));
      if (!doComprador.length) continue;
      const ultima = doComprador[0];
      processadas++;

      const { id, ehSituacaoNova } = await sacStore.upsertAtendimento(empresaId, 'mercado_livre', contaId, {
        tipoOrigem: 'mensagem',
        idExterno: `${pedido.pack_id}:${ultima.id || ultima.message_date?.created || ''}`,
        pedidoRef: pedido.ml_order_id ? String(pedido.ml_order_id) : null,
        sku: null,
        produtoTitulo: null,
        clienteNome: pedido.comprador_nickname || null,
        clienteIdExterno: pedido.comprador_id ? String(pedido.comprador_id) : null,
        mensagemCliente: ultima.text || ultima.message || '(mensagem sem texto — possível anexo/imagem)',
        dataRecebido: (ultima.message_date && ultima.message_date.created) || new Date().toISOString(),
        raw: ultima,
      });
      if (ehSituacaoNova) { novos++; idsNovos.push(id); }
    } catch (err) {
      // isola por pedido — um pack_id com erro (ex.: conversa expirada)
      // nunca derruba os outros
      console.error(`[SAC Mercado Livre][mensagens] pack ${pedido.pack_id}: ${err.message}`);
    }
  }
  return { processadas, novos, idsNovos };
}

// Reclamações/mediações (inclui devoluções formais, que no Mercado Livre
// nascem como um tipo de claim — ver db/schema.sql, tipo_origem
// 'reclamacao' cobre os dois até uma eventual etapa futura separar por
// `type`/`reason` real da API).
async function sincronizarReclamacoes({ empresaId, contaId, accessToken, sellerId }) {
  const resposta = await ml.buscarReclamacoes({ accessToken, sellerId, limit: LIMITE_RECLAMACOES });
  const reclamacoes = (resposta && (resposta.data || resposta.results)) || [];
  if (!reclamacoes.length) return { processadas: 0, novos: 0, idsNovos: [] };

  let novos = 0;
  const idsNovos = [];
  for (const c of reclamacoes) {
    let mensagemCliente = null;
    try {
      const msgResp = await ml.buscarMensagensReclamacao({ accessToken, claimId: c.id });
      const mensagens = (msgResp && (msgResp.data || msgResp)) || [];
      const doComprador = Array.isArray(mensagens)
        ? mensagens.filter((m) => m.sender_role && m.sender_role !== 'respondent').sort((a, b) => new Date(b.date_created) - new Date(a.date_created))
        : [];
      if (doComprador.length) mensagemCliente = doComprador[0].message || doComprador[0].text || null;
    } catch (err) {
      console.error(`[SAC Mercado Livre][reclamações] mensagens do claim ${c.id}: ${err.message}`);
    }
    // Sem mensagem de texto disponível: usa os campos estruturados que a
    // própria API devolveu (nunca um texto livre inventado) pra o
    // atendimento não ficar sem contexto nenhum.
    if (!mensagemCliente) {
      mensagemCliente = `Reclamação aberta — tipo: ${c.type || 'não informado'}, motivo: ${c.reason_id || 'não informado'}, etapa: ${c.stage || 'não informada'} (sem mensagem de texto disponível).`;
    }

    const { id, ehSituacaoNova } = await sacStore.upsertAtendimento(empresaId, 'mercado_livre', contaId, {
      tipoOrigem: 'reclamacao',
      idExterno: String(c.id),
      pedidoRef: c.resource_id ? String(c.resource_id) : null,
      sku: null,
      produtoTitulo: null,
      clienteNome: null,
      clienteIdExterno: null,
      mensagemCliente,
      dataRecebido: c.date_created || c.last_updated || new Date().toISOString(),
      raw: c,
    });
    if (ehSituacaoNova) { novos++; idsNovos.push(id); }
  }
  return { processadas: reclamacoes.length, novos, idsNovos };
}

// Ponto de entrada — sincroniza as 3 fontes de UMA conta do Mercado Livre.
// Cada fonte é isolada: uma falhar não impede as outras (resultado sempre
// diz "erro" na fonte que falhou, nunca lança pra fora).
async function sincronizarContaMercadoLivre(contaId) {
  const conta = await getContaComTokenValido(contaId);
  const accessToken = decrypt(conta.access_token_enc);
  const contexto = { empresaId: conta.empresa_id, contaId: conta.id, accessToken, sellerId: conta.ml_user_id };

  const resultado = {};
  for (const [chave, fn] of Object.entries({
    perguntas: sincronizarPerguntas,
    mensagens: sincronizarMensagensPosVenda,
    reclamacoes: sincronizarReclamacoes,
  })) {
    try {
      resultado[chave] = await fn(contexto);
    } catch (err) {
      console.error(`[SAC Mercado Livre][${chave}] conta ${contaId}: ${err.message}`);
      resultado[chave] = { processadas: 0, novos: 0, erro: err.message };
    }
  }
  return { empresaId: conta.empresa_id, contaId: conta.id, ...resultado };
}

module.exports = { sincronizarContaMercadoLivre };
