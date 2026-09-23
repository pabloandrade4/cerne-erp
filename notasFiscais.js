// Notas Fiscais — ativado em 24/08/2026. Estrutura para REGISTRAR e
// ACOMPANHAR notas relacionadas a um pedido — nesta etapa não existe
// emissão real (SEFAZ). O ERP nunca inventa número de NF-e nem chave de
// acesso: esses campos só existem no banco quando o usuário realmente os
// digita (porque já emitiu a nota em outro sistema fiscal e quer
// registrar/acompanhar aqui). Um pedido sem nota registrada aparece como
// "pendente" — nunca como erro ou dado ausente.
//
// `pedido_id` é UNIQUE em notas_fiscais (uma nota por pedido nesta
// primeira versão — ver docs/02-decisoes.md). `cliente` e `empresa/CNPJ`
// nunca são gravados aqui — vêm sempre de JOIN com ml_pedidos/empresas,
// pra nunca duplicar um dado que já existe no pedido.
const pool = require('../db/pool');
const { buscarPedidosDoPeriodo } = require('./relatorioVendas');

const STATUS_VALIDOS = ['pendente', 'emitida', 'cancelada', 'rejeitada'];
const MARKETPLACE_LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', balcao: 'Venda no balcão' };

// CORREÇÃO (22/09/2026, feature "Venda de Balcão" — ver db/schema.sql e o
// mesmo ajuste em lib/faturamento.js): consultava só ml_pedidos por id —
// bug pré-existente pra Shopee, que ia se repetir pra Balcão (id pode
// colidir entre as 3 tabelas, cada uma com sua própria sequência SERIAL).
// Agora recebe o marketplace (vindo do detailKey composto) e consulta a
// tabela certa, sempre sem ambiguidade.
async function empresaDoPedido(pedidoId, marketplace) {
  if (marketplace === 'shopee') {
    const { rows } = await pool.query(
      `SELECT c.empresa_id FROM shopee_pedidos p JOIN shopee_contas c ON c.id = p.conta_shopee_id WHERE p.id = $1`,
      [pedidoId]
    );
    return rows.length ? rows[0].empresa_id : null;
  }
  if (marketplace === 'balcao') {
    const { rows } = await pool.query(`SELECT empresa_id FROM vendas_balcao WHERE id = $1`, [pedidoId]);
    return rows.length ? rows[0].empresa_id : null;
  }
  const { rows } = await pool.query(
    `SELECT c.empresa_id FROM ml_pedidos p JOIN ml_contas c ON c.id = p.conta_ml_id WHERE p.id = $1`,
    [pedidoId]
  );
  return rows.length ? rows[0].empresa_id : null;
}

// Separa um `detailKey` ("mercado_livre:123"/"shopee:57"/"balcao:9") em
// marketplace + id bruto — mesma função de lib/faturamento.js (duplicada
// aqui de propósito, os dois módulos já eram independentes um do outro
// antes desta mudança e não vale a pena criar um módulo compartilhado só
// por isso).
function separarDetailKey(detailKey) {
  const chave = String(detailKey || '');
  const pos = chave.indexOf(':');
  if (pos === -1) return { marketplace: 'mercado_livre', pedidoId: chave };
  return { marketplace: chave.slice(0, pos), pedidoId: chave.slice(pos + 1) };
}

function round2(n) { return Math.round(n * 100) / 100; }

// Lista os pedidos do período (empresa + período do header) com a nota
// fiscal de cada um, quando existir — mesma lógica de "reaproveitar a
// fonte única de pedidos" já usada em Faturamento/DRE/Recebimentos.
async function listarNotasFiscais({ empresaId, desde, ate, status, search }) {
  const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });

  // Mesma correção de chave composta aplicada em lib/faturamento.js —
  // pedido_id sozinho pode colidir entre os 3 canais.
  const ids = pedidos.map((p) => p.id);
  let notasPorPedido = {};
  if (ids.length) {
    const { rows } = await pool.query(
      'SELECT * FROM notas_fiscais WHERE pedido_id = ANY($1::int[])',
      [ids]
    );
    notasPorPedido = Object.fromEntries(rows.map((r) => [`${r.marketplace}:${r.pedido_id}`, r]));
  }

  let itens = pedidos.map((p) => {
    const nota = notasPorPedido[p.detailKey];
    return {
      notaId: nota ? nota.id : null,
      pedidoId: p.id,
      detailKey: p.detailKey,
      mlOrderId: p.mlOrderId,
      marketplace: MARKETPLACE_LABEL[p.marketplace] || p.marketplace,
      loja: p.loja,
      cliente: p.compradorNickname,
      valorPedido: p.valorTotal,
      numero: nota ? nota.numero : null,
      serie: nota ? nota.serie : null,
      chaveAcesso: nota ? nota.chave_acesso : null,
      valor: nota ? (nota.valor === null ? null : Number(nota.valor)) : null,
      dataEmissao: nota && nota.data_emissao ? String(nota.data_emissao).slice(0, 10) : null,
      status: nota ? nota.status : 'pendente',
      observacao: nota ? nota.observacao : null,
    };
  });

  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    itens = itens.filter((i) =>
      String(i.mlOrderId).includes(q) ||
      (i.cliente || '').toLowerCase().includes(q) ||
      (i.numero || '').toLowerCase().includes(q)
    );
  }
  if (status) itens = itens.filter((i) => i.status === status);

  return { itens, totalNoPeriodo };
}

function validatePayload(body) {
  const errors = {};
  const out = {};

  const status = body.status || 'pendente';
  if (!STATUS_VALIDOS.includes(status)) errors.status = 'Status inválido.';
  else out.status = status;

  if (body.numero !== undefined) {
    const numero = String(body.numero || '').trim();
    if (numero.length > 20) errors.numero = 'Número muito longo (máx. 20 caracteres).';
    else out.numero = numero || null;
  }
  if (body.serie !== undefined) {
    const serie = String(body.serie || '').trim();
    if (serie.length > 10) errors.serie = 'Série muito longa (máx. 10 caracteres).';
    else out.serie = serie || null;
  }
  if (body.chaveAcesso !== undefined) {
    const chave = String(body.chaveAcesso || '').replace(/\D/g, '');
    if (chave && chave.length !== 44) errors.chaveAcesso = 'A chave de acesso deve ter 44 dígitos.';
    else out.chaveAcesso = chave || null;
  }
  if (body.valor !== undefined) {
    const valor = body.valor === null || body.valor === '' ? null : Number(body.valor);
    if (valor !== null && (!Number.isFinite(valor) || valor <= 0)) errors.valor = 'Informe um valor maior que zero.';
    else out.valor = valor === null ? null : round2(valor);
  }
  if (body.dataEmissao !== undefined) {
    const data = String(body.dataEmissao || '').trim();
    if (data && !/^\d{4}-\d{2}-\d{2}$/.test(data)) errors.dataEmissao = 'Data de emissão inválida.';
    else out.dataEmissao = data || null;
  }
  if (body.observacao !== undefined) {
    out.observacao = String(body.observacao || '').trim() || null;
  }

  // Uma nota só pode ficar "emitida" se realmente tiver os dados de uma
  // nota emitida de verdade — nunca aceitar "emitida" com número/série/
  // data/chave em branco, pra nunca fingir uma emissão que não aconteceu.
  if (out.status === 'emitida') {
    if (!out.numero) errors.numero = errors.numero || 'Informe o número da nota já emitida.';
    if (!out.serie) errors.serie = errors.serie || 'Informe a série da nota já emitida.';
    if (!out.dataEmissao) errors.dataEmissao = errors.dataEmissao || 'Informe a data de emissão.';
    if (!out.chaveAcesso) errors.chaveAcesso = errors.chaveAcesso || 'Informe a chave de acesso (44 dígitos).';
  }

  return { errors, data: out };
}

// Cria ou atualiza (upsert por pedido_id + marketplace) a nota fiscal de
// um pedido. Recebe o `detailKey` composto ("marketplace:id"), não mais o
// id numérico sozinho — mesmo motivo do ajuste em lib/faturamento.js.
async function registrarNota(detailKey, body) {
  const { errors, data } = validatePayload(body);
  if (Object.keys(errors).length) return { errors };

  const { marketplace, pedidoId } = separarDetailKey(detailKey);
  const empresaId = await empresaDoPedido(pedidoId, marketplace);
  if (empresaId === null) return { notFound: true };

  const { rows } = await pool.query(
    `INSERT INTO notas_fiscais (pedido_id, empresa_id, marketplace, numero, serie, chave_acesso, valor, data_emissao, status, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (pedido_id, marketplace) DO UPDATE SET
       numero = $4, serie = $5, chave_acesso = $6, valor = $7, data_emissao = $8, status = $9, observacao = $10, updated_at = now()
     RETURNING *`,
    [pedidoId, empresaId, marketplace, data.numero || null, data.serie || null, data.chaveAcesso || null, data.valor ?? null, data.dataEmissao || null, data.status, data.observacao || null]
  );
  return { nota: rows[0] };
}

async function buscarPorPedido(detailKey) {
  const { marketplace, pedidoId } = separarDetailKey(detailKey);
  const { rows } = await pool.query('SELECT * FROM notas_fiscais WHERE pedido_id = $1 AND marketplace = $2', [pedidoId, marketplace]);
  return rows[0] || null;
}

module.exports = {
  STATUS_VALIDOS,
  MARKETPLACE_LABEL,
  listarNotasFiscais,
  registrarNota,
  buscarPorPedido,
  empresaDoPedido,
  separarDetailKey,
  validatePayload,
};
