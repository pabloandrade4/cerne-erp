// Produto base + vínculo de SKU: o estoque físico não é controlado pelo
// SKU do kit vendido no Mercado Livre (ex: '100CX-19X12X12'), e sim pelo
// modelo físico real por trás dele (ex: 'CX-19X12X12'). Aqui fica só a
// ESTRUTURA (produto base, SKU de venda, multiplicador) e a conversão de
// venda para quantidade física — nada de estoque, Full, compras,
// relatórios, margem ou financeiro é lido/alterado por este arquivo
// (pedido explícito do usuário nesta etapa). Ver docs/01-regras-de-negocio.md
// e docs/02-decisoes.md.
const express = require('express');
const pool = require('../db/pool');
const { interpretarSku } = require('../lib/skuProdutoBase');
const { converterItens, SELECT_VINCULO } = require('../lib/produtoBaseConversao');

const router = express.Router();

function serializeProdutoBase(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    codigo: row.codigo,
    nome: row.nome,
    medida: row.medida || null,
    categoria: row.categoria || null,
    custo: row.custo === null || row.custo === undefined ? null : Number(row.custo),
    ativo: row.ativo,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

function serializeAlias(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    produtoBaseId: row.produto_base_id,
    produtoBaseCodigo: row.produto_base_codigo,
    produtoBaseNome: row.produto_base_nome,
    alias: row.alias,
    origem: row.origem,
    criadoEm: row.created_at,
  };
}

const SELECT_ALIAS = `
  SELECT a.*, pb.codigo AS produto_base_codigo, pb.nome AS produto_base_nome
  FROM produto_base_aliases a
  JOIN produtos_base pb ON pb.id = a.produto_base_id
`;

function serializeVinculo(row) {
  return {
    id: row.id,
    empresaId: row.empresa_id,
    sku: row.sku,
    produtoBaseId: row.produto_base_id,
    produtoBaseCodigo: row.produto_base_codigo,
    produtoBaseNome: row.produto_base_nome,
    multiplicador: row.multiplicador,
    origem: row.origem,
    criadoEm: row.created_at,
    atualizadoEm: row.updated_at,
  };
}

// Busca o produto base pelo código (por empresa); cria se ainda não existir.
async function obterOuCriarProdutoBase(empresaId, codigo, nome) {
  const codigoLimpo = String(codigo || '').trim();
  if (!codigoLimpo) throw Object.assign(new Error('Informe o código do produto base.'), { status: 400 });

  const existente = await pool.query(
    'SELECT * FROM produtos_base WHERE empresa_id = $1 AND codigo = $2',
    [empresaId, codigoLimpo]
  );
  if (existente.rows.length) return existente.rows[0];

  const { rows } = await pool.query(
    `INSERT INTO produtos_base (empresa_id, codigo, nome) VALUES ($1,$2,$3) RETURNING *`,
    [empresaId, codigoLimpo, nome ? String(nome).trim() : null]
  );
  return rows[0];
}

// ============================================================
// Produtos base (CRUD)
// ============================================================

// GET /api/produtos-base?empresaId=ID&status=ativos|inativos&search=texto&categoria=texto
// `search` também casa com medida (ex: buscar "16x11x6" encontra o produto
// mesmo que o código cadastrado seja outro) — é o mesmo campo que a futura
// ferramenta de IA `identificar_produto_fisico` vai reaproveitar.
router.get('/', async (req, res, next) => {
  try {
    const { empresaId, status, search, categoria } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const conditions = ['empresa_id = $1'];
    const params = [empresaId];
    if (status === 'ativos') conditions.push('ativo = TRUE');
    else if (status === 'inativos') conditions.push('ativo = FALSE');
    if (search) {
      params.push('%' + search + '%');
      const idx = params.length;
      conditions.push(`(codigo ILIKE $${idx} OR nome ILIKE $${idx} OR medida ILIKE $${idx})`);
    }
    if (categoria) {
      params.push(categoria);
      conditions.push(`categoria = $${params.length}`);
    }

    const { rows } = await pool.query(
      `SELECT * FROM produtos_base WHERE ${conditions.join(' AND ')} ORDER BY codigo`,
      params
    );
    res.json({ produtosBase: rows.map(serializeProdutoBase) });
  } catch (err) { next(err); }
});

// GET /api/produtos-base/categorias-sugeridas?empresaId=ID — categorias já
// usadas por esta empresa (distinct), para autocompletar a tela — texto
// livre, sem lista fixa (ao contrário de contas_pagar), porque a categoria
// de produto físico varia demais entre negócios diferentes para uma lista
// genérica fazer sentido.
router.get('/categorias-sugeridas', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows } = await pool.query(
      `SELECT DISTINCT categoria FROM produtos_base
       WHERE empresa_id = $1 AND categoria IS NOT NULL AND categoria <> ''
       ORDER BY categoria`,
      [empresaId]
    );
    res.json({ categorias: rows.map((r) => r.categoria) });
  } catch (err) { next(err); }
});

// POST /api/produtos-base — cria um produto base
router.post('/', async (req, res, next) => {
  try {
    const empresaId = Number(req.body.empresaId);
    const codigo = String(req.body.codigo || '').trim();
    const nome = req.body.nome ? String(req.body.nome).trim() : null;
    const medida = req.body.medida ? String(req.body.medida).trim() : null;
    const categoria = req.body.categoria ? String(req.body.categoria).trim() : null;
    const custo = req.body.custo !== undefined && req.body.custo !== null && req.body.custo !== ''
      ? Number(req.body.custo) : null;

    const errors = {};
    if (!empresaId) errors.empresaId = 'Selecione a empresa.';
    if (!codigo) errors.codigo = 'Informe o código do produto base.';
    else if (codigo.length > 100) errors.codigo = 'Código muito longo (máx. 100 caracteres).';
    if (medida && medida.length > 100) errors.medida = 'Medida muito longa (máx. 100 caracteres).';
    if (categoria && categoria.length > 100) errors.categoria = 'Categoria muito longa (máx. 100 caracteres).';
    if (custo !== null && (!Number.isFinite(custo) || custo < 0)) errors.custo = 'Informe um custo válido (maior ou igual a zero).';
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const { rows } = await pool.query(
      `INSERT INTO produtos_base (empresa_id, codigo, nome, medida, categoria, custo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [empresaId, codigo, nome, medida, categoria, custo]
    );
    res.status(201).json({ produtoBase: serializeProdutoBase(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { codigo: 'Já existe um produto base com esse código nesta empresa.' } });
    next(err);
  }
});

// PUT /api/produtos-base/:id — edita código/nome/custo
router.put('/:id', async (req, res, next) => {
  try {
    const fields = [];
    const values = [];
    let i = 1;

    if (req.body.codigo !== undefined) {
      const codigo = String(req.body.codigo || '').trim();
      if (!codigo) return res.status(400).json({ errors: { codigo: 'Informe o código do produto base.' } });
      fields.push(`codigo = $${i++}`); values.push(codigo);
    }
    if (req.body.nome !== undefined) {
      fields.push(`nome = $${i++}`); values.push(req.body.nome ? String(req.body.nome).trim() : null);
    }
    if (req.body.medida !== undefined) {
      const medida = req.body.medida ? String(req.body.medida).trim() : null;
      if (medida && medida.length > 100) return res.status(400).json({ errors: { medida: 'Medida muito longa (máx. 100 caracteres).' } });
      fields.push(`medida = $${i++}`); values.push(medida);
    }
    if (req.body.categoria !== undefined) {
      const categoria = req.body.categoria ? String(req.body.categoria).trim() : null;
      if (categoria && categoria.length > 100) return res.status(400).json({ errors: { categoria: 'Categoria muito longa (máx. 100 caracteres).' } });
      fields.push(`categoria = $${i++}`); values.push(categoria);
    }
    if (req.body.custo !== undefined) {
      const custo = req.body.custo === null || req.body.custo === '' ? null : Number(req.body.custo);
      if (custo !== null && (!Number.isFinite(custo) || custo < 0)) {
        return res.status(400).json({ errors: { custo: 'Informe um custo válido (maior ou igual a zero).' } });
      }
      fields.push(`custo = $${i++}`); values.push(custo);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar.' });

    fields.push('updated_at = now()');
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE produtos_base SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto base não encontrado.' });
    res.json({ produtoBase: serializeProdutoBase(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ errors: { codigo: 'Já existe um produto base com esse código nesta empresa.' } });
    next(err);
  }
});

// PATCH /api/produtos-base/:id/status — ativar/desativar
router.patch('/:id/status', async (req, res, next) => {
  try {
    const ativo = Boolean(req.body.ativo);
    const { rows } = await pool.query(
      `UPDATE produtos_base SET ativo = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [ativo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Produto base não encontrado.' });
    res.json({ produtoBase: serializeProdutoBase(rows[0]) });
  } catch (err) { next(err); }
});

// ============================================================
// Vínculos: SKU de venda -> produto base -> multiplicador
// ============================================================

// GET /api/produtos-base/vinculos?empresaId=ID — lista todos os vínculos já salvos
router.get('/vinculos', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows } = await pool.query(
      `${SELECT_VINCULO} WHERE v.empresa_id = $1 ORDER BY v.sku`,
      [empresaId]
    );
    res.json({ vinculos: rows.map(serializeVinculo) });
  } catch (err) { next(err); }
});

// GET /api/produtos-base/vinculos/sugestoes?empresaId=ID — SKUs que já
// apareceram em pedidos reais desta empresa e AINDA NÃO têm vínculo
// salvo, com uma sugestão de interpretação (quando o texto do SKU permite)
// e quantas vezes cada SKU já apareceu. Não grava nada — é só uma prévia
// para o usuário revisar/corrigir antes de confirmar.
router.get('/vinculos/sugestoes', async (req, res, next) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const { rows } = await pool.query(
      `SELECT i.sku, COUNT(*) AS ocorrencias
       FROM ml_pedido_itens i
       JOIN ml_pedidos p ON p.id = i.pedido_id
       JOIN ml_contas c ON c.id = p.conta_ml_id
       WHERE c.empresa_id = $1
         AND i.sku IS NOT NULL
         AND i.sku NOT IN (SELECT sku FROM produto_base_skus WHERE empresa_id = $1)
       GROUP BY i.sku
       ORDER BY COUNT(*) DESC, i.sku`,
      [empresaId]
    );

    const { rows: basesExistentes } = await pool.query(
      'SELECT id, codigo FROM produtos_base WHERE empresa_id = $1',
      [empresaId]
    );
    const baseIdPorCodigo = Object.fromEntries(basesExistentes.map((b) => [b.codigo, b.id]));

    const sugestoes = rows.map((row) => {
      const interpretado = interpretarSku(row.sku);
      return {
        sku: row.sku,
        ocorrencias: Number(row.ocorrencias),
        sugestao: interpretado
          ? {
              multiplicador: interpretado.multiplicador,
              codigoBase: interpretado.codigoBase,
              produtoBaseExistenteId: baseIdPorCodigo[interpretado.codigoBase] || null,
            }
          : null,
      };
    });

    res.json({ sugestoes });
  } catch (err) { next(err); }
});

// POST /api/produtos-base/vinculos — cria um vínculo SKU -> produto base
// Aceita `produtoBaseId` (produto já existente) OU `codigoProdutoBase`
// (cria o produto base na hora, se ainda não existir com esse código).
// `origem` é 'manual' por padrão; quando o vínculo vem de uma sugestão
// aceita como está, o chamador pode mandar `origem: 'automatico'` — de
// qualquer forma, o vínculo salvo aqui é sempre o que vale.
router.post('/vinculos', async (req, res, next) => {
  try {
    const empresaId = Number(req.body.empresaId);
    const sku = String(req.body.sku || '').trim();
    const multiplicador = Number(req.body.multiplicador);
    const produtoBaseId = req.body.produtoBaseId ? Number(req.body.produtoBaseId) : null;
    const codigoProdutoBase = req.body.codigoProdutoBase ? String(req.body.codigoProdutoBase).trim() : null;
    const origem = req.body.origem === 'automatico' ? 'automatico' : 'manual';

    const errors = {};
    if (!empresaId) errors.empresaId = 'Selecione a empresa.';
    if (!sku) errors.sku = 'Informe o SKU.';
    if (!Number.isInteger(multiplicador) || multiplicador <= 0) errors.multiplicador = 'Informe um multiplicador inteiro maior que zero.';
    if (!produtoBaseId && !codigoProdutoBase) errors.produtoBase = 'Informe o produto base (produtoBaseId ou codigoProdutoBase).';
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    let baseId = produtoBaseId;
    if (!baseId) {
      const base = await obterOuCriarProdutoBase(empresaId, codigoProdutoBase);
      baseId = base.id;
    }

    const { rows } = await pool.query(
      `INSERT INTO produto_base_skus (empresa_id, sku, produto_base_id, multiplicador, origem)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [empresaId, sku, baseId, multiplicador, origem]
    );
    const { rows: completo } = await pool.query(`${SELECT_VINCULO} WHERE v.id = $1`, [rows[0].id]);
    res.status(201).json({ vinculo: serializeVinculo(completo[0]) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ errors: { sku: 'Esse SKU já tem um vínculo cadastrado nesta empresa — edite o vínculo existente.' } });
    if (err.code === '23503') return res.status(400).json({ errors: { produtoBaseId: 'Produto base não encontrado.' } });
    next(err);
  }
});

// PUT /api/produtos-base/vinculos/:id — corrige manualmente o vínculo
// (produto base e/ou multiplicador). Toda correção manual marca
// origem = 'manual', mesmo que o vínculo tivesse começado automático.
router.put('/vinculos/:id', async (req, res, next) => {
  try {
    const { rows: atuais } = await pool.query('SELECT * FROM produto_base_skus WHERE id = $1', [req.params.id]);
    if (!atuais.length) return res.status(404).json({ error: 'Vínculo não encontrado.' });
    const atual = atuais[0];

    let baseId = atual.produto_base_id;
    if (req.body.produtoBaseId !== undefined) {
      baseId = Number(req.body.produtoBaseId);
    } else if (req.body.codigoProdutoBase !== undefined) {
      const base = await obterOuCriarProdutoBase(atual.empresa_id, req.body.codigoProdutoBase);
      baseId = base.id;
    }

    let multiplicador = atual.multiplicador;
    if (req.body.multiplicador !== undefined) {
      multiplicador = Number(req.body.multiplicador);
      if (!Number.isInteger(multiplicador) || multiplicador <= 0) {
        return res.status(400).json({ errors: { multiplicador: 'Informe um multiplicador inteiro maior que zero.' } });
      }
    }

    const { rows } = await pool.query(
      `UPDATE produto_base_skus
       SET produto_base_id = $1, multiplicador = $2, origem = 'manual', updated_at = now()
       WHERE id = $3 RETURNING id`,
      [baseId, multiplicador, req.params.id]
    );
    const { rows: completo } = await pool.query(`${SELECT_VINCULO} WHERE v.id = $1`, [rows[0].id]);
    res.json({ vinculo: serializeVinculo(completo[0]) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23503') return res.status(400).json({ errors: { produtoBaseId: 'Produto base não encontrado.' } });
    next(err);
  }
});

// DELETE /api/produtos-base/vinculos/:id — remove o vínculo (o SKU volta a
// ficar "sem vínculo", aparecendo de novo em .../vinculos/sugestoes)
router.delete('/vinculos/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM produto_base_skus WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vínculo não encontrado.' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ============================================================
// Aliases: como o usuário chama o produto físico em linguagem natural
// ============================================================
// Pré-requisito para a futura ferramenta de IA `identificar_produto_fisico`
// (etapa seguinte da proposta de contexto de negócio — ainda não
// implementada). Por enquanto só CRUD manual pela tela; a IA nunca grava
// aqui sem confirmação explícita do usuário, mesma disciplina do resto do
// projeto (ver docs/PROPOSTA-contexto-negocio-ia-gestora.md).

// GET /api/produtos-base/aliases?empresaId=ID&produtoBaseId=ID(opcional)&search=texto(opcional)
router.get('/aliases', async (req, res, next) => {
  try {
    const { empresaId, produtoBaseId, search } = req.query;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });

    const conditions = ['a.empresa_id = $1'];
    const params = [empresaId];
    if (produtoBaseId) {
      params.push(produtoBaseId);
      conditions.push(`a.produto_base_id = $${params.length}`);
    }
    if (search) {
      params.push('%' + search + '%');
      conditions.push(`a.alias ILIKE $${params.length}`);
    }

    const { rows } = await pool.query(
      `${SELECT_ALIAS} WHERE ${conditions.join(' AND ')} ORDER BY a.alias`,
      params
    );
    res.json({ aliases: rows.map(serializeAlias) });
  } catch (err) { next(err); }
});

// POST /api/produtos-base/aliases — cria um alias para um produto base.
// Aceita `produtoBaseId` (produto já existente) OU `codigoProdutoBase`
// (cria o produto base na hora, se ainda não existir — mesmo padrão já
// usado em POST /vinculos). `origem` é 'manual' por padrão; só aceita
// 'ia_sugerido' quando explicitamente enviado (uso futuro pela IA, sempre
// após confirmação do usuário na conversa — nunca decidido por este endpoint).
router.post('/aliases', async (req, res, next) => {
  try {
    const empresaId = Number(req.body.empresaId);
    const alias = String(req.body.alias || '').trim();
    const produtoBaseId = req.body.produtoBaseId ? Number(req.body.produtoBaseId) : null;
    const codigoProdutoBase = req.body.codigoProdutoBase ? String(req.body.codigoProdutoBase).trim() : null;
    const origem = req.body.origem === 'ia_sugerido' ? 'ia_sugerido' : 'manual';

    const errors = {};
    if (!empresaId) errors.empresaId = 'Selecione a empresa.';
    if (!alias) errors.alias = 'Informe o apelido.';
    else if (alias.length > 200) errors.alias = 'Apelido muito longo (máx. 200 caracteres).';
    if (!produtoBaseId && !codigoProdutoBase) errors.produtoBase = 'Informe o produto base (produtoBaseId ou codigoProdutoBase).';
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    let baseId = produtoBaseId;
    if (!baseId) {
      const base = await obterOuCriarProdutoBase(empresaId, codigoProdutoBase);
      baseId = base.id;
    }

    const { rows } = await pool.query(
      `INSERT INTO produto_base_aliases (empresa_id, produto_base_id, alias, origem)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [empresaId, baseId, alias, origem]
    );
    const { rows: completo } = await pool.query(`${SELECT_ALIAS} WHERE a.id = $1`, [rows[0].id]);
    res.status(201).json({ alias: serializeAlias(completo[0]) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ errors: { alias: 'Esse apelido já está cadastrado nesta empresa — edite ou remova o existente.' } });
    if (err.code === '23503') return res.status(400).json({ errors: { produtoBaseId: 'Produto base não encontrado.' } });
    next(err);
  }
});

// PUT /api/produtos-base/aliases/:id — corrige o texto do apelido e/ou
// reatribui a outro produto base. Toda correção manual marca origem =
// 'manual', mesmo que o apelido tivesse começado como 'ia_sugerido'
// (mesmo padrão já usado em PUT /vinculos/:id).
router.put('/aliases/:id', async (req, res, next) => {
  try {
    const { rows: atuais } = await pool.query('SELECT * FROM produto_base_aliases WHERE id = $1', [req.params.id]);
    if (!atuais.length) return res.status(404).json({ error: 'Apelido não encontrado.' });
    const atual = atuais[0];

    let baseId = atual.produto_base_id;
    if (req.body.produtoBaseId !== undefined) {
      baseId = Number(req.body.produtoBaseId);
    } else if (req.body.codigoProdutoBase !== undefined) {
      const base = await obterOuCriarProdutoBase(atual.empresa_id, req.body.codigoProdutoBase);
      baseId = base.id;
    }

    let alias = atual.alias;
    if (req.body.alias !== undefined) {
      alias = String(req.body.alias || '').trim();
      if (!alias) return res.status(400).json({ errors: { alias: 'Informe o apelido.' } });
      if (alias.length > 200) return res.status(400).json({ errors: { alias: 'Apelido muito longo (máx. 200 caracteres).' } });
    }

    const { rows } = await pool.query(
      `UPDATE produto_base_aliases SET produto_base_id = $1, alias = $2, origem = 'manual' WHERE id = $3 RETURNING id`,
      [baseId, alias, req.params.id]
    );
    const { rows: completo } = await pool.query(`${SELECT_ALIAS} WHERE a.id = $1`, [rows[0].id]);
    res.json({ alias: serializeAlias(completo[0]) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ errors: { alias: 'Esse apelido já está cadastrado nesta empresa.' } });
    if (err.code === '23503') return res.status(400).json({ errors: { produtoBaseId: 'Produto base não encontrado.' } });
    next(err);
  }
});

// DELETE /api/produtos-base/aliases/:id — remove o apelido
router.delete('/aliases/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM produto_base_aliases WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Apelido não encontrado.' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ============================================================
// Conversão: venda (SKU + quantidade) -> quantidade física do produto base
// ============================================================

// POST /api/produtos-base/conversao — calculadora genérica
// body: { empresaId, itens: [{ sku, quantidade }, ...] }
router.post('/conversao', async (req, res, next) => {
  try {
    const empresaId = Number(req.body.empresaId);
    const itens = Array.isArray(req.body.itens) ? req.body.itens : null;
    if (!empresaId) return res.status(400).json({ error: 'Informe empresaId.' });
    if (!itens || !itens.length) return res.status(400).json({ error: 'Informe ao menos um item ({ sku, quantidade }).' });

    const resultado = await converterItens(empresaId, itens);
    res.json(resultado);
  } catch (err) { next(err); }
});

// GET /api/produtos-base/conversao/pedido/:pedidoId — converte os itens de
// um pedido REAL já importado (demonstração com dado de verdade, sem
// alterar nada do pedido em si).
router.get('/conversao/pedido/:pedidoId', async (req, res, next) => {
  try {
    const { rows: pedidoRows } = await pool.query(
      `SELECT p.id, p.ml_order_id, c.empresa_id
       FROM ml_pedidos p JOIN ml_contas c ON c.id = p.conta_ml_id
       WHERE p.id = $1`,
      [req.params.pedidoId]
    );
    if (!pedidoRows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const pedido = pedidoRows[0];

    const { rows: itens } = await pool.query(
      'SELECT sku, quantidade FROM ml_pedido_itens WHERE pedido_id = $1 ORDER BY id',
      [pedido.id]
    );

    const resultado = await converterItens(pedido.empresa_id, itens);
    res.json({ pedidoId: pedido.id, mlOrderId: String(pedido.ml_order_id), ...resultado });
  } catch (err) { next(err); }
});

module.exports = router;
