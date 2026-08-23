// Estoque PRÓPRIO (nunca misturado com o Estoque Full do Mercado Livre —
// ver routes/estoqueFull.js, que não guarda nada no banco). Mostra os
// produtos cadastrados (tela Produtos) com a quantidade em estoque, custo
// unitário e valor total em estoque. Ajuste manual por enquanto — cada
// ajuste grava uma linha em estoque_movimentos, preparando o histórico de
// movimentação mesmo sem ainda existir uma tela própria para vê-lo.
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

function serializeItem(row) {
  const quantidade = row.quantidade === null ? 0 : Number(row.quantidade);
  const custo = Number(row.custo);
  return {
    produtoId: row.produto_id,
    empresaId: row.empresa_id,
    nome: row.nome,
    sku: row.sku,
    custoUnitario: custo,
    quantidade,
    valorTotal: Math.round(quantidade * custo * 100) / 100,
    ativo: row.ativo,
    estoqueAtualizadoEm: row.estoque_atualizado_em,
  };
}

// GET /api/estoque?empresaId=ID&status=ativos|inativos&search=texto
// Lista todos os produtos da empresa (ativos e inativos, salvo filtro), com
// a quantidade em estoque — produto sem nenhum ajuste ainda aparece com
// quantidade 0 (nunca "sem dado").
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, status, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const conditions = ['p.empresa_id = $1'];
    const params = [empresaId];
    if (status === 'ativos') conditions.push('p.ativo = TRUE');
    else if (status === 'inativos') conditions.push('p.ativo = FALSE');
    if (search) {
      params.push('%' + search + '%');
      const idx = params.length;
      conditions.push('(p.nome ILIKE $' + idx + ' OR p.sku ILIKE $' + idx + ')');
    }

    const { rows } = await pool.query(
      `SELECT p.id AS produto_id, p.empresa_id, p.nome, p.sku, p.custo, p.ativo,
              e.quantidade, e.atualizado_em AS estoque_atualizado_em
       FROM produtos p
       LEFT JOIN estoque e ON e.produto_id = p.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.nome`,
      params
    );
    res.json({ itens: rows.map(serializeItem) });
  } catch (err) { next(err); }
});

// PUT /api/estoque/:produtoId — ajuste manual: define a quantidade nova e
// grava a movimentação (quantidade anterior, nova, diferença e observação).
router.put('/:produtoId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const produtoId = req.params.produtoId;
    const novaQuantidade = Number(req.body.quantidade);
    const observacao = req.body.observacao ? String(req.body.observacao).trim().slice(0, 500) : null;

    if (!Number.isInteger(novaQuantidade) || novaQuantidade < 0) {
      return res.status(400).json({ errors: { quantidade: 'Informe uma quantidade inteira, maior ou igual a zero.' } });
    }

    await client.query('BEGIN');

    const { rows: produtoRows } = await client.query('SELECT * FROM produtos WHERE id = $1', [produtoId]);
    if (!produtoRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }

    const { rows: estoqueRows } = await client.query('SELECT * FROM estoque WHERE produto_id = $1 FOR UPDATE', [produtoId]);
    let estoque = estoqueRows[0];
    const quantidadeAnterior = estoque ? estoque.quantidade : 0;

    if (estoque) {
      const { rows } = await client.query(
        'UPDATE estoque SET quantidade = $1, atualizado_em = now() WHERE id = $2 RETURNING *',
        [novaQuantidade, estoque.id]
      );
      estoque = rows[0];
    } else {
      const { rows } = await client.query(
        'INSERT INTO estoque (produto_id, quantidade) VALUES ($1,$2) RETURNING *',
        [produtoId, novaQuantidade]
      );
      estoque = rows[0];
    }

    await client.query(
      `INSERT INTO estoque_movimentos (estoque_id, tipo, quantidade_anterior, quantidade_nova, diferenca, observacao)
       VALUES ($1, 'ajuste_manual', $2, $3, $4, $5)`,
      [estoque.id, quantidadeAnterior, novaQuantidade, novaQuantidade - quantidadeAnterior, observacao]
    );

    await client.query('COMMIT');

    const produto = produtoRows[0];
    res.json({
      item: serializeItem({
        produto_id: produto.id,
        empresa_id: produto.empresa_id,
        nome: produto.nome,
        sku: produto.sku,
        custo: produto.custo,
        ativo: produto.ativo,
        quantidade: estoque.quantidade,
        estoque_atualizado_em: estoque.atualizado_em,
      }),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
