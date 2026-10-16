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
// lib/relatorioVendas.js pra sugerir só SKUs que, se cadastrados aqui do
// jeito que aparecem no pedido, vão bater certinho com o cálculo de margem.
// Nunca sugere um SKU que já está cadastrado (por mais que o produto atual
// esteja sem custo por outro motivo — essa rota é só pra SKU nunca visto em
// Produtos).
// 28/09/2026 — CORRIGIDO: a comparação de "já cadastrado" era exata
// (sku NOT IN (...)), então um SKU com maiúscula/minúscula diferente do
// cadastro (ex.: "100cx-16x11x6" vs "100CX-16X11X6") ou com uma quebra de
// linha colada no fim aparecia aqui como sugestão, mesmo já tendo produto
// e custo cadastrados — e cadastrar de novo criaria um SKU duplicado, sem
// resolver o pareamento de verdade. Agora compara normalizado
// (UPPER(BTRIM(...))), mesma normalização usada em lib/relatorioVendas.js.
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
       WHERE UPPER(BTRIM(sku)) NOT IN (SELECT UPPER(BTRIM(sku)) FROM produtos WHERE empresa_id = $1)
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

// ---- Atualizar CUSTO por planilha (02/10/2026, pedido explícito do usuário)
// Ver lib/produtosImportacao.js. Três rotas, todas ANTES de '/:id'.

// GET /api/produtos/custos/modelo?empresaId=ID — planilha com os produtos
// atuais (SKU, Nome, Custo) pra editar a coluna Custo e enviar de volta.
router.get('/custos/modelo', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const { rows } = await pool.query('SELECT sku, nome, custo FROM produtos WHERE empresa_id = $1 ORDER BY nome', [empresaId]);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Custos');
    ws.addRow(['SKU', 'Nome', 'Custo']);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.columns = [{ key: 'sku', width: 26 }, { key: 'nome', width: 50 }, { key: 'custo', width: 14, style: { numFmt: '#,##0.00' } }];
    for (const r of rows) ws.addRow([r.sku, r.nome, Number(r.custo)]);
    const ins = wb.addWorksheet('Instruções');
    ins.addRows([
      ['Como usar'],
      ['1. Edite só a coluna Custo (em reais, ex.: 3,50). Não mude o SKU — é ele que identifica o produto.'],
      ['2. Pode apagar as linhas dos produtos que não quer mexer, ou deixar o Custo em branco (o custo atual é mantido).'],
      ['3. Salve e envie o arquivo em Cadastros → Produtos → Atualizar custos por planilha. Você vê uma prévia antes de gravar.'],
      ['4. SKU que não existe em Produtos não é criado — aparece como "não encontrado" na prévia.'],
    ]);
    ins.getRow(1).font = { bold: true };
    ins.getColumn(1).width = 110;
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="custos-produtos.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) { next(err); }
});

// POST /api/produtos/custos/importar?empresaId=ID&confirmar=0|1 — corpo = bytes
// crus do CSV/XLSX (header X-File-Name). confirmar=0 só mostra a prévia;
// confirmar=1 grava (tudo ou nada, numa transação).
router.post('/custos/importar', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res, next) => {
  try {
    const importacaoCsv = require('../lib/contasPagarImportacao');
    const prodImport = require('../lib/produtosImportacao');
    const empresaId = Number(req.query.empresaId);
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    const nomeArquivo = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    if (!nomeArquivo) return res.status(400).json({ error: 'Informe o nome do arquivo.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Arquivo vazio.' });

    const lido = await importacaoCsv.lerArquivo(req.body, nomeArquivo);
    if (!lido.colunas.length || !lido.linhas.length) return res.status(400).json({ error: 'Não encontrei cabeçalho ou linhas de dados na planilha.' });
    const mapeamento = prodImport.detectarColunas(lido.colunas);
    if (!mapeamento.sku || !mapeamento.custo) {
      return res.status(400).json({ error: 'A planilha precisa ter uma coluna "SKU" e uma coluna "Custo". Colunas encontradas: ' + lido.colunas.join(', ') + '.' });
    }

    const { rows: produtos } = await pool.query('SELECT id, sku, nome, custo FROM produtos WHERE empresa_id = $1', [empresaId]);
    const avaliacao = prodImport.avaliarLinhas(lido.linhas, mapeamento, produtos);

    if (String(req.query.confirmar) !== '1') return res.json({ confirmado: false, ...avaliacao });

    const aAtualizar = avaliacao.linhas.filter(l => l.status === 'atualizar');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const l of aAtualizar) {
        await client.query('UPDATE produtos SET custo = $1, updated_at = now() WHERE empresa_id = $2 AND id = ANY($3::int[])', [l.custoNovo, empresaId, l.produtoIds]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    res.json({ confirmado: true, atualizados: aAtualizar.length, ...avaliacao });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
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
