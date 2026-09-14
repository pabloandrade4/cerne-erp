// Cadastro simples de produtos, por empresa: nome, SKU, custo e status
// (ativo/inativo). Ainda não tem kits, composição nem controle de estoque
// automático.
//
// Desde 24/08/2026: esta é a ÚNICA fonte de custo por SKU usada no cálculo
// de margem das vendas do Mercado Livre (lib/relatorioVendas.js lê direto
// da tabela `produtos`). A antiga tela separada "Custo & Margem" (tabela
// `custos_produto`) foi removida e seus dados migrados pra cá — ver
// db/migrate.js, db/schema.sql e docs/02-decisoes.md. A margem em si
// continua calculada só nas vendas (Pedidos/Visão Geral/Financeiro/
// Relatórios) — esta tela nunca mostra margem, só cadastra/edita SKU e
// custo (a alíquota de imposto, que continua única por empresa, é
// cadastrada aqui também, mas via routes/custos.js -> config_financeiro).
const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

function serialize(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    nome: row.nome,
    sku: row.sku,
    custo: Number(row.custo),
    ativo: row.ativo,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

function validatePayload(body, { partial = false } = {}) {
  const errors = {};
  const out = {};

  if (!partial) {
    const empresaId = Number(body.empresaId);
    if (!empresaId) errors.empresaId = 'Selecione a empresa.';
    else out.empresaId = empresaId;
  }

  if (!partial || body.nome !== undefined) {
    const nome = String(body.nome || '').trim();
    if (!nome) errors.nome = 'Informe o nome do produto.';
    else if (nome.length > 200) errors.nome = 'Nome muito longo (máx. 200 caracteres).';
    else out.nome = nome;
  }

  if (!partial || body.sku !== undefined) {
    const sku = String(body.sku || '').trim();
    if (!sku) errors.sku = 'Informe o SKU.';
    else if (sku.length > 100) errors.sku = 'SKU muito longo (máx. 100 caracteres).';
    else out.sku = sku;
  }

  if (!partial || body.custo !== undefined) {
    const custo = Number(body.custo);
    if (!Number.isFinite(custo) || custo < 0) errors.custo = 'Informe um custo válido (maior ou igual a zero).';
    else out.custo = custo;
  }

  if (body.ativo !== undefined) out.ativo = Boolean(body.ativo);

  return { errors, data: out };
}

// GET /api/produtos?empresaId=ID&status=ativos|inativos&search=texto
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, status, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const conditions = ['empresa_id = $1'];
    const params = [empresaId];
    if (status === 'ativos') conditions.push('ativo = TRUE');
    else if (status === 'inativos') conditions.push('ativo = FALSE');
    if (search) {
      params.push('%' + search + '%');
      const idx = params.length;
      conditions.push('(nome ILIKE $' + idx + ' OR sku ILIKE $' + idx + ')');
    }

    const { rows } = await pool.query(
      `SELECT * FROM produtos WHERE ${conditions.join(' AND ')} ORDER BY nome`,
      params
    );
    res.json({ produtos: rows.map(serialize) });
  } catch (err) { next(err); }
});

// GET /api/produtos/sugestoes-sku?empresaId=ID
// 14/09/2026, pedido explícito do usuário: "como podemos fazer para puxar
// o sku com o custo direto" — em vez de digitar o SKU na mão ao cadastrar
// um produto novo (risco de erro de digitação, que faz o custo nunca
// "casar" com a venda — mesmo problema de fundo do bug do frete de hoje,
// mas pro lado do SKU), esta rota devolve os SKUs que JÁ apareceram em
// pedidos reais (Mercado Livre + Shopee) desta empresa mas que AINDA não
// têm produto cadastrado — exatamente a mesma lógica de casamento usada em
// lib/relatorioVendas.js (pr.sku = pi.sku, comparação exata) pra sugerir só
// SKUs que, se cadastrados aqui do jeito que aparecem no pedido, vão bater
// certinho com o cálculo de margem. Nunca sugere um SKU que já está
// cadastrado (por mais que o produto atual esteja sem custo por outro
// motivo — essa rota é só pra SKU nunca visto em Produtos).
router.get('/sugestoes-sku', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows } = await pool.query(
      `WITH itens_ml AS (
         SELECT pi.sku, pi.titulo AS nome, pi.pedido_id, p.data_criacao AS data_pedido
         FROM ml_pedido_itens pi
         JOIN ml_pedidos p ON p.id = pi.pedido_id
         JOIN ml_contas c ON c.id = p.conta_ml_id
         WHERE c.empresa_id = $1 AND pi.sku IS NOT NULL AND pi.sku <> ''
       ),
       itens_shopee AS (
         SELECT pi.sku, pi.nome, pi.pedido_id, p.data_criacao AS data_pedido
         FROM shopee_pedido_itens pi
         JOIN shopee_pedidos p ON p.id = pi.pedido_id
         JOIN shopee_contas c ON c.id = p.conta_shopee_id
         WHERE c.empresa_id = $1 AND pi.sku IS NOT NULL AND pi.sku <> ''
       ),
       todos AS (
         SELECT * FROM itens_ml
         UNION ALL
         SELECT * FROM itens_shopee
       )
       -- nome_sugerido usa o nome do PEDIDO MAIS RECENTE (por data_criacao,
       -- nunca pela ordem de inserção/id — um pedido antigo pode ser
       -- sincronizado depois de um mais novo) — desempate por pedido_id só
       -- pra determinismo quando a data for idêntica.
       SELECT sku,
              (array_agg(nome ORDER BY data_pedido DESC NULLS LAST, pedido_id DESC))[1] AS nome_sugerido,
              count(DISTINCT pedido_id) AS qtd_pedidos
       FROM todos
       WHERE sku NOT IN (SELECT sku FROM produtos WHERE empresa_id = $1)
       GROUP BY sku
       ORDER BY qtd_pedidos DESC, sku
       LIMIT 500`,
      [empresaId]
    );

    res.json({
      sugestoes: rows.map((r) => ({
        sku: r.sku,
        nomeSugerido: r.nome_sugerido,
        qtdPedidos: Number(r.qtd_pedidos),
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/produtos/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM produtos WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ produto: serialize(rows[0]) });
  } catch (err) { next(err); }
});

// POST /api/produtos — cria
router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = validatePayload(req.body);
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const { rows } = await pool.query(
      `INSERT INTO produtos (empresa_id, nome, sku, custo, ativo)
       VALUES ($1,$2,$3,$4, COALESCE($5, TRUE))
       RETURNING *`,
      [data.empresaId, data.nome, data.sku, data.custo, data.ativo]
    );
    res.status(201).json({ produto: serialize(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { sku: 'Já existe um produto com esse SKU nesta empresa.' } });
    next(err);
  }
});

// PUT /api/produtos/:id — edita (parcial)
router.put('/:id', async (req, res, next) => {
  try {
    const { errors, data } = validatePayload(req.body, { partial: true });
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nada para atualizar.' });

    const fields = [];
    const values = [];
    let i = 1;
    const colMap = { nome: 'nome', sku: 'sku', custo: 'custo', ativo: 'ativo' };
    for (const [key, col] of Object.entries(colMap)) {
      if (data[key] !== undefined) { fields.push(`${col} = $${i++}`); values.push(data[key]); }
    }
    fields.push(`updated_at = now()`);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE produtos SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ produto: serialize(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { sku: 'Já existe um produto com esse SKU nesta empresa.' } });
    next(err);
  }
});

// PATCH /api/produtos/:id/status — ativar/desativar
router.patch('/:id/status', async (req, res, next) => {
  try {
    const ativo = Boolean(req.body.ativo);
    const { rows } = await pool.query(
      `UPDATE produtos SET ativo = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ produto: serialize(rows[0]) });
  } catch (err) { next(err); }
});

module.exports = router;
