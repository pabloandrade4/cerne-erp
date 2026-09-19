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

async function empresaDoPedido(pedidoId) {
  const { rows } = await pool.query(
    `SELECT c.empresa_id FROM ml_pedidos p JOIN ml_contas c ON c.id = p.conta_ml_id WHERE p.id = $1`,
    [pedidoId]
  );
  return rows.length ? rows[0].empresa_id : null;
}

function round2(n) { return Math.round(n * 100) / 100; }

// Lista os pedidos do período (empresa + período do header) com a nota
// fiscal de cada um, quando existir — mesma lógica de "reaproveitar a
// fonte única de pedidos" já usada em Faturamento/DRE/Recebimentos.
async function listarNotasFiscais({ empresaId, desde, ate, status, search }) {
  const { pedidos, totalNoPeriodo } = await buscarPedidosDoPeriodo({ empresaId, desde, ate });

  const ids = pedidos.map((p) => p.id);
  let notasPorPedido = {};
  if (ids.length) {
    const { rows } = await pool.query(
      'SELECT * FROM notas_fiscais WHERE pedido_id = ANY($1::int[])',
      [ids]
    );
    notasPorPedido = Object.fromEntries(rows.map((r) => [r.pedido_id, r]));
  }

  let itens = pedidos.map((p) => {
    const nota = notasPorPedido[p.id];
    return {
      notaId: nota ? nota.id : null,
      pedidoId: p.id,
      mlOrderId: p.mlOrderId,
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

// Cria ou atualiza (upsert por pedido_id) a nota fiscal de um pedido.
async function registrarNota(pedidoId, body) {
  const { errors, data } = validatePayload(body);
  if (Object.keys(errors).length) return { errors };

  const empresaId = await empresaDoPedido(pedidoId);
  if (empresaId === null) return { notFound: true };

  const { rows } = await pool.query(
    `INSERT INTO notas_fiscais (pedido_id, empresa_id, numero, serie, chave_acesso, valor, data_emissao, status, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (pedido_id) DO UPDATE SET
       numero = $3, serie = $4, chave_acesso = $5, valor = $6, data_emissao = $7, status = $8, observacao = $9, updated_at = now()
     RETURNING *`,
    [pedidoId, empresaId, data.numero || null, data.serie || null, data.chaveAcesso || null, data.valor ?? null, data.dataEmissao || null, data.status, data.observacao || null]
  );
  return { nota: rows[0] };
}

async function buscarPorPedido(pedidoId) {
  const { rows } = await pool.query('SELECT * FROM notas_fiscais WHERE pedido_id = $1', [pedidoId]);
  return rows[0] || null;
}

module.exports = {
  STATUS_VALIDOS,
  listarNotasFiscais,
  registrarNota,
  buscarPorPedido,
  empresaDoPedido,
  validatePayload,
};
