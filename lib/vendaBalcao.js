// Venda de Balcão / "Calculadora de Vendas" — ativado em 22/09/2026 (pedido
// explícito do usuário: "quero colocar agora uma calculadora de vendas pra
// eu vende[r] para o cliente final que vem até a minha empresa... porque
// todas as vendas que eu faço pro fora eu nao coloco no faturamento sei que
// isso é errado mas quero arrumar"). Ver db/schema.sql (tabelas
// vendas_balcao/vendas_balcao_itens) e docs/02-decisoes.md para o desenho
// completo — respostas do usuário (todas a opção recomendada): conta em
// TODO o sistema, baixa do estoque, produto sempre do catálogo já
// cadastrado (produtos.sku, pra reaproveitar o mesmo custo já usado nas
// vendas do Mercado Livre/Shopee), sempre pago na hora.
//
// Este módulo é só o CRUD da venda em si (criar, listar, cancelar). A
// integração com o resto do sistema (Visão Geral/DRE/Relatórios/
// Faturamento) mora em lib/relatorioVendas.js (3º canal 'balcao' no
// mesmo UNION ALL que já une Mercado Livre + Shopee), nunca duplicada aqui.
const pool = require('../db/pool');
const { round2 } = require('./resultadoVenda');

const FORMAS_PAGAMENTO_VALIDAS = ['dinheiro', 'pix', 'debito', 'credito', 'outro'];
const STATUS_VALIDOS = ['concluida', 'cancelada'];

function serializeVenda(row) {
  return {
    id: row.id,
    marketplace: 'balcao',
    detailKey: `balcao:${row.id}`,
    empresaId: row.empresa_id,
    numeroVenda: row.numero_venda,
    clienteNome: row.cliente_nome,
    formaPagamento: row.forma_pagamento,
    desconto: Number(row.desconto) || 0,
    valorTotal: Number(row.valor_total),
    custoProdutoTotal: row.custo_produto_total === null ? null : Number(row.custo_produto_total),
    observacao: row.observacao,
    status: row.status,
    cancelado: row.status === 'cancelada',
    dataVenda: row.data_venda,
    canceladoEm: row.cancelado_em,
  };
}

function serializeItem(row) {
  return {
    id: row.id,
    vendaId: row.venda_id,
    sku: row.sku,
    titulo: row.titulo,
    quantidade: Number(row.quantidade),
    precoUnitarioVenda: Number(row.preco_unitario_venda),
    custoUnitario: row.custo_unitario === null ? null : Number(row.custo_unitario),
    valorTotalItem: Number(row.valor_total_item),
  };
}

// Valida o payload de criação — nunca aceita item sem SKU de um produto
// REALMENTE cadastrado (decisão do usuário: "escolher produto cadastrado",
// não digitar um produto solto) nem quantidade/preço inválidos. O custo
// nunca é digitado aqui — vem sempre de `produtos.custo` (ver criarVenda).
function validatePayload(body) {
  const errors = {};
  const out = {};

  const empresaId = Number(body.empresaId);
  if (!empresaId) errors.empresaId = 'Selecione a empresa.';
  else out.empresaId = empresaId;

  const formaPagamento = String(body.formaPagamento || '').trim();
  if (!FORMAS_PAGAMENTO_VALIDAS.includes(formaPagamento)) errors.formaPagamento = 'Selecione uma forma de pagamento válida.';
  else out.formaPagamento = formaPagamento;

  const clienteNome = String(body.clienteNome || '').trim();
  if (clienteNome.length > 200) errors.clienteNome = 'Nome do cliente muito longo (máx. 200 caracteres).';
  else out.clienteNome = clienteNome || null;

  const observacao = String(body.observacao || '').trim();
  out.observacao = observacao || null;

  const desconto = body.desconto === undefined || body.desconto === null || body.desconto === '' ? 0 : Number(body.desconto);
  if (!Number.isFinite(desconto) || desconto < 0) errors.desconto = 'Informe um desconto válido (maior ou igual a zero).';
  else out.desconto = round2(desconto);

  const itensBrutos = Array.isArray(body.itens) ? body.itens : [];
  if (!itensBrutos.length) {
    errors.itens = 'Adicione ao menos um produto à venda.';
  } else {
    const itens = [];
    itensBrutos.forEach((it, idx) => {
      const sku = String((it && it.sku) || '').trim();
      const quantidade = Number(it && it.quantidade);
      const precoUnitarioVenda = Number(it && it.precoUnitarioVenda);
      if (!sku) { errors.itens = errors.itens || `Item ${idx + 1}: selecione um produto do catálogo.`; return; }
      if (!Number.isFinite(quantidade) || quantidade <= 0) { errors.itens = errors.itens || `Item ${idx + 1}: informe uma quantidade válida (maior que zero).`; return; }
      if (!Number.isFinite(precoUnitarioVenda) || precoUnitarioVenda < 0) { errors.itens = errors.itens || `Item ${idx + 1}: informe um preço de venda válido (maior ou igual a zero).`; return; }
      itens.push({ sku, quantidade, precoUnitarioVenda });
    });
    if (!errors.itens) out.itens = itens;
  }

  return { errors, data: out };
}

// Cria a venda inteira (cabeçalho + itens) numa única transação — se
// qualquer SKU não estiver cadastrado em Produtos (ou não pertencer a esta
// empresa), a venda inteira é rejeitada ANTES de gravar nada (nunca uma
// venda "pela metade" com um item sem produto real por trás).
async function criarVenda(body) {
  const { errors, data } = validatePayload(body);
  if (Object.keys(errors).length) return { errors };

  const skus = [...new Set(data.itens.map((it) => it.sku))];
  const { rows: produtosRows } = await pool.query(
    'SELECT sku, nome, custo FROM produtos WHERE empresa_id = $1 AND sku = ANY($2::text[])',
    [data.empresaId, skus]
  );
  const produtosPorSku = Object.fromEntries(produtosRows.map((p) => [p.sku, p]));
  const skusNaoEncontrados = skus.filter((sku) => !produtosPorSku[sku]);
  if (skusNaoEncontrados.length) {
    return { errors: { itens: `Produto(s) não encontrado(s) no catálogo desta empresa: ${skusNaoEncontrados.join(', ')}. Cadastre em Produtos antes de vender.` } };
  }

  let custoCompleto = true;
  let custoProdutoTotal = 0;
  let valorTotalItens = 0;
  const itensParaGravar = data.itens.map((it) => {
    const produto = produtosPorSku[it.sku];
    const custoUnitario = produto.custo === null || produto.custo === undefined ? null : Number(produto.custo);
    const valorTotalItem = round2(it.quantidade * it.precoUnitarioVenda);
    valorTotalItens = round2(valorTotalItens + valorTotalItem);
    if (custoUnitario === null) custoCompleto = false;
    else custoProdutoTotal = round2(custoProdutoTotal + round2(custoUnitario * it.quantidade));
    return {
      sku: it.sku,
      titulo: produto.nome,
      quantidade: it.quantidade,
      precoUnitarioVenda: it.precoUnitarioVenda,
      custoUnitario,
      valorTotalItem,
    };
  });

  // valor_total é o BRUTO (soma dos itens, antes do desconto) — mesma
  // convenção já usada pelo Mercado Livre/Shopee em lib/relatorioVendas.js:
  // o desconto é aplicado à parte, dentro de calcularResultadoVenda
  // (lib/resultadoVenda.js), nunca pré-descontado aqui. Gravar já descontado
  // faria o desconto ser subtraído DUAS vezes na margem.
  const valorTotal = valorTotalItens;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: seqRows } = await client.query(`SELECT nextval('vendas_balcao_numero_seq') AS numero`);
    const numeroVenda = Number(seqRows[0].numero);

    const { rows: vendaRows } = await client.query(
      `INSERT INTO vendas_balcao
         (empresa_id, numero_venda, cliente_nome, forma_pagamento, desconto, valor_total, custo_produto_total, observacao, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'concluida')
       RETURNING *`,
      [data.empresaId, numeroVenda, data.clienteNome, data.formaPagamento, data.desconto, valorTotal, custoCompleto ? custoProdutoTotal : null, data.observacao]
    );
    const venda = vendaRows[0];

    const itensGravados = [];
    for (const it of itensParaGravar) {
      const { rows } = await client.query(
        `INSERT INTO vendas_balcao_itens (venda_id, sku, titulo, quantidade, preco_unitario_venda, custo_unitario, valor_total_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [venda.id, it.sku, it.titulo, it.quantidade, it.precoUnitarioVenda, it.custoUnitario, it.valorTotalItem]
      );
      itensGravados.push(rows[0]);
    }

    await client.query('COMMIT');
    return { venda: serializeVenda(venda), itens: itensGravados.map(serializeItem) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Lista as vendas de balcão de uma empresa no período — usada pelo
// histórico da própria tela da calculadora. NÃO passa por
// buscarPedidosDoPeriodo (lib/relatorioVendas.js) de propósito: esta é a
// listagem "de gestão da venda em si" (cancelar, ver itens digitados) —
// quem precisa do número já unificado com Mercado Livre/Shopee (Visão
// Geral/DRE/Relatórios/Faturamento) usa relatorioVendas.js, que lê
// exatamente estas mesmas tabelas por baixo.
async function listarVendas({ empresaId, desde, ate, status, search }) {
  const condicoes = ['empresa_id = $1', 'data_venda >= $2', 'data_venda < $3'];
  const params = [empresaId, desde, ate];
  if (status && STATUS_VALIDOS.includes(status)) {
    params.push(status);
    condicoes.push(`status = $${params.length}`);
  }
  if (search && search.trim()) {
    params.push('%' + search.trim() + '%');
    const idx = params.length;
    condicoes.push(`(cliente_nome ILIKE $${idx} OR numero_venda::text ILIKE $${idx})`);
  }

  const { rows } = await pool.query(
    `SELECT * FROM vendas_balcao WHERE ${condicoes.join(' AND ')} ORDER BY data_venda DESC LIMIT 500`,
    params
  );
  if (!rows.length) return { vendas: [] };

  const vendaIds = rows.map((r) => r.id);
  const { rows: itensRows } = await pool.query(
    'SELECT * FROM vendas_balcao_itens WHERE venda_id = ANY($1::int[]) ORDER BY id',
    [vendaIds]
  );
  const itensPorVenda = new Map();
  itensRows.forEach((it) => {
    if (!itensPorVenda.has(it.venda_id)) itensPorVenda.set(it.venda_id, []);
    itensPorVenda.get(it.venda_id).push(serializeItem(it));
  });

  return {
    vendas: rows.map((r) => ({ ...serializeVenda(r), itens: itensPorVenda.get(r.id) || [] })),
  };
}

async function buscarVendaPorId(id, empresaId) {
  const { rows } = await pool.query('SELECT * FROM vendas_balcao WHERE id = $1 AND empresa_id = $2', [id, empresaId]);
  return rows[0] || null;
}

// Cancela (nunca apaga — mesmo padrão do resto do sistema). Uma venda já
// cancelada não pode ser cancelada de novo (nem tem sentido, nem
// sobrescreveria `cancelado_em` de um cancelamento anterior).
async function cancelarVenda(id, empresaId) {
  const { rows } = await pool.query(
    `UPDATE vendas_balcao SET status = 'cancelada', cancelado_em = now(), updated_at = now()
     WHERE id = $1 AND empresa_id = $2 AND status = 'concluida'
     RETURNING *`,
    [id, empresaId]
  );
  if (!rows.length) {
    const existente = await buscarVendaPorId(id, empresaId);
    if (!existente) return { notFound: true };
    return { errors: { geral: 'Esta venda já está cancelada.' } };
  }
  return { venda: serializeVenda(rows[0]) };
}

module.exports = {
  FORMAS_PAGAMENTO_VALIDAS,
  STATUS_VALIDOS,
  validatePayload,
  criarVenda,
  listarVendas,
  buscarVendaPorId,
  cancelarVenda,
  serializeVenda,
  serializeItem,
};
