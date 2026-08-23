// Pedido de compra a um fornecedor — primeira versão simples: criar,
// listar, editar, pesquisar e mudar status. Nesta etapa NÃO existe IA de
// compras nem entrada automática de estoque ao marcar como "Recebido"
// (pedido explícito do usuário) — o módulo só registra o pedido de compra
// em si. "valor_total" é sempre recalculado no servidor a partir dos itens
// enviados, nunca aceito pronto do front-end.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const STATUS_VALIDOS = ['em_aberto', 'pedido_realizado', 'recebido', 'cancelado'];
const STATUS_LABEL = {
  em_aberto: 'Em aberto',
  pedido_realizado: 'Pedido realizado',
  recebido: 'Recebido',
  cancelado: 'Cancelado',
};

function serializeCompra(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    fornecedorId: row.fornecedor_id,
    fornecedorNome: row.fornecedor_razao_social || null,
    dataCompra: row.data_compra,
    previsaoChegada: row.previsao_chegada,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    valorTotal: Number(row.valor_total),
    observacao: row.observacao,
    qtdItens: row.qtd_itens !== undefined ? Number(row.qtd_itens) : undefined,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

function serializeItem(row) {
  return {
    id: row.id,
    compraId: row.compra_id,
    produtoId: row.produto_id,
    produtoNome: row.produto_nome || null,
    produtoSku: row.produto_sku || null,
    quantidade: Number(row.quantidade),
    custoUnitario: Number(row.custo_unitario),
    valorTotalItem: Number(row.valor_total_item),
  };
}

function validatePayloadBase(body) {
  const errors = {};
  const out = {};

  const empresaId = Number(body.empresaId);
  if (!empresaId) errors.empresaId = 'Selecione a empresa.';
  else out.empresaId = empresaId;

  const fornecedorId = Number(body.fornecedorId);
  if (!fornecedorId) errors.fornecedorId = 'Selecione o fornecedor.';
  else out.fornecedorId = fornecedorId;

  const dataCompra = String(body.dataCompra || '').trim();
  if (dataCompra && !/^\d{4}-\d{2}-\d{2}$/.test(dataCompra)) errors.dataCompra = 'Data da compra inválida.';
  else out.dataCompra = dataCompra || null; // null -> banco usa CURRENT_DATE

  const previsaoChegada = String(body.previsaoChegada || '').trim();
  if (previsaoChegada && !/^\d{4}-\d{2}-\d{2}$/.test(previsaoChegada)) errors.previsaoChegada = 'Previsão de chegada inválida.';
  else out.previsaoChegada = previsaoChegada || null;

  out.observacao = String(body.observacao || '').trim() || null;

  return { errors, data: out };
}

// Valida os itens da compra (produto pertence à empresa, quantidade e
// custo válidos) e já calcula o valor de cada item — usa o client da
// transação em andamento.
async function validarItens(client, empresaId, itensBody) {
  const errors = {};
  if (!Array.isArray(itensBody) || !itensBody.length) {
    errors.itens = 'Adicione pelo menos um produto à compra.';
    return { errors, itens: [] };
  }

  const itens = [];
  for (let i = 0; i < itensBody.length; i++) {
    const raw = itensBody[i] || {};
    const produtoId = Number(raw.produtoId);
    const quantidade = Number(raw.quantidade);
    const custoUnitario = Number(raw.custoUnitario);

    if (!produtoId) { errors.itens = 'Selecione o produto de cada item.'; break; }
    if (!Number.isInteger(quantidade) || quantidade <= 0) { errors.itens = 'Informe uma quantidade válida (inteiro maior que zero) em cada item.'; break; }
    if (!Number.isFinite(custoUnitario) || custoUnitario < 0) { errors.itens = 'Informe um custo unitário válido (maior ou igual a zero) em cada item.'; break; }

    const { rows } = await client.query('SELECT id, empresa_id FROM produtos WHERE id = $1', [produtoId]);
    if (!rows.length || Number(rows[0].empresa_id) !== Number(empresaId)) {
      errors.itens = 'Um dos produtos selecionados não pertence a esta empresa.';
      break;
    }

    itens.push({ produtoId, quantidade, custoUnitario, valorTotalItem: Math.round(quantidade * custoUnitario * 100) / 100 });
  }

  return { errors, itens };
}

async function buscarCompraCompleta(id) {
  const { rows } = await pool.query(
    `SELECT c.*, f.razao_social AS fornecedor_razao_social
     FROM compras c JOIN fornecedores f ON f.id = c.fornecedor_id
     WHERE c.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// GET /api/compras?empresaId=ID&status=em_aberto|pedido_realizado|recebido|cancelado&search=texto
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, status, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const conditions = ['c.empresa_id = $1'];
    const params = [empresaId];
    if (status && STATUS_VALIDOS.includes(status)) { params.push(status); conditions.push('c.status = $' + params.length); }
    if (search) {
      params.push('%' + search + '%');
      const idx = params.length;
      conditions.push('(f.razao_social ILIKE $' + idx + ' OR f.nome_fantasia ILIKE $' + idx + ')');
    }

    const { rows } = await pool.query(
      `SELECT c.*, f.razao_social AS fornecedor_razao_social,
              (SELECT COUNT(*) FROM compra_itens ci WHERE ci.compra_id = c.id) AS qtd_itens
       FROM compras c
       JOIN fornecedores f ON f.id = c.fornecedor_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY c.data_compra DESC, c.id DESC`,
      params
    );
    res.json({ compras: rows.map(serializeCompra) });
  } catch (err) { next(err); }
});

// GET /api/compras/:id — detalhe com itens
router.get('/:id', async (req, res, next) => {
  try {
    const compra = await buscarCompraCompleta(req.params.id);
    if (!compra) return res.status(404).json({ error: 'Compra não encontrada.' });

    const { rows: itensRows } = await pool.query(
      `SELECT ci.*, p.nome AS produto_nome, p.sku AS produto_sku
       FROM compra_itens ci JOIN produtos p ON p.id = ci.produto_id
       WHERE ci.compra_id = $1 ORDER BY ci.id`,
      [req.params.id]
    );

    res.json({ compra: { ...serializeCompra(compra), itens: itensRows.map(serializeItem) } });
  } catch (err) { next(err); }
});

// POST /api/compras — cria a compra com os itens
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { errors, data } = validatePayloadBase(req.body);
    if (Object.keys(errors).length) { return res.status(400).json({ errors }); }

    await client.query('BEGIN');

    const { rows: fornRows } = await client.query('SELECT id, empresa_id FROM fornecedores WHERE id = $1', [data.fornecedorId]);
    if (!fornRows.length || Number(fornRows[0].empresa_id) !== Number(data.empresaId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ errors: { fornecedorId: 'Fornecedor não encontrado nesta empresa.' } });
    }

    const { errors: itensErrors, itens } = await validarItens(client, data.empresaId, req.body.itens);
    if (Object.keys(itensErrors).length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ errors: itensErrors });
    }

    const valorTotal = itens.reduce((acc, it) => acc + it.valorTotalItem, 0);

    const { rows: compraRows } = await client.query(
      `INSERT INTO compras (empresa_id, fornecedor_id, data_compra, previsao_chegada, status, valor_total, observacao)
       VALUES ($1,$2, COALESCE($3, CURRENT_DATE), $4, 'em_aberto', $5, $6)
       RETURNING *`,
      [data.empresaId, data.fornecedorId, data.dataCompra, data.previsaoChegada, valorTotal, data.observacao]
    );
    const compra = compraRows[0];

    for (const it of itens) {
      await client.query(
        `INSERT INTO compra_itens (compra_id, produto_id, quantidade, custo_unitario, valor_total_item)
         VALUES ($1,$2,$3,$4,$5)`,
        [compra.id, it.produtoId, it.quantidade, it.custoUnitario, it.valorTotalItem]
      );
    }

    await client.query('COMMIT');

    const completa = await buscarCompraCompleta(compra.id);
    res.status(201).json({ compra: serializeCompra(completa) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/compras/:id — edita (fornecedor, datas, observação e os itens —
// os itens são sempre substituídos pelos itens enviados, mesmo padrão já
// usado em ml_pedido_itens ao ressincronizar um pedido do Mercado Livre)
router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: existingRows } = await client.query('SELECT * FROM compras WHERE id = $1', [req.params.id]);
    if (!existingRows.length) { return res.status(404).json({ error: 'Compra não encontrada.' }); }
    const existing = existingRows[0];

    const { errors, data } = validatePayloadBase(req.body);
    if (Object.keys(errors).length) { return res.status(400).json({ errors }); }
    if (Number(data.empresaId) !== Number(existing.empresa_id)) {
      return res.status(400).json({ error: 'Não é permitido mudar a empresa de uma compra existente.' });
    }

    await client.query('BEGIN');

    const { rows: fornRows } = await client.query('SELECT id, empresa_id FROM fornecedores WHERE id = $1', [data.fornecedorId]);
    if (!fornRows.length || Number(fornRows[0].empresa_id) !== Number(data.empresaId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ errors: { fornecedorId: 'Fornecedor não encontrado nesta empresa.' } });
    }

    const { errors: itensErrors, itens } = await validarItens(client, data.empresaId, req.body.itens);
    if (Object.keys(itensErrors).length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ errors: itensErrors });
    }

    const valorTotal = itens.reduce((acc, it) => acc + it.valorTotalItem, 0);

    await client.query(
      `UPDATE compras SET fornecedor_id=$1, data_compra=COALESCE($2, data_compra), previsao_chegada=$3,
              valor_total=$4, observacao=$5, updated_at=now()
       WHERE id=$6`,
      [data.fornecedorId, data.dataCompra, data.previsaoChegada, valorTotal, data.observacao, req.params.id]
    );

    await client.query('DELETE FROM compra_itens WHERE compra_id = $1', [req.params.id]);
    for (const it of itens) {
      await client.query(
        `INSERT INTO compra_itens (compra_id, produto_id, quantidade, custo_unitario, valor_total_item)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, it.produtoId, it.quantidade, it.custoUnitario, it.valorTotalItem]
      );
    }

    await client.query('COMMIT');

    const completa = await buscarCompraCompleta(req.params.id);
    res.json({ compra: serializeCompra(completa) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/compras/:id/status — muda só o status (não mexe em estoque)
router.patch('/:id/status', async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    if (!STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({ errors: { status: 'Status inválido.' } });
    }
    const { rows } = await pool.query(
      `UPDATE compras SET status = $1, updated_at = now() WHERE id = $2 RETURNING id`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Compra não encontrada.' });

    const completa = await buscarCompraCompleta(req.params.id);
    res.json({ compra: serializeCompra(completa) });
  } catch (err) { next(err); }
});

module.exports = router;
