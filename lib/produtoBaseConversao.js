// Conversão de SKU de venda (kit) -> quantidade física do produto base,
// usando os vínculos salvos em `produto_base_skus`. Compartilhado entre a
// conversão de vendas (routes/produtosBase.js) e a agregação de estoque
// (routes/estoqueProdutoBase.js) — mesma regra nos dois lugares: SKU sem
// vínculo salvo NUNCA soma um valor estimado, vai para `pendentes`.
const pool = require('../db/pool');

const SELECT_VINCULO = `
  SELECT v.*, pb.codigo AS produto_base_codigo, pb.nome AS produto_base_nome, pb.custo AS produto_base_custo
  FROM produto_base_skus v
  JOIN produtos_base pb ON pb.id = v.produto_base_id
`;

// itens: [{ sku, quantidade }, ...] -> agrega por produto base.
async function converterItens(empresaId, itens) {
  const skus = [...new Set(itens.map((it) => it.sku).filter(Boolean))];
  let vinculosPorSku = {};
  if (skus.length) {
    const { rows } = await pool.query(
      `${SELECT_VINCULO} WHERE v.empresa_id = $1 AND v.sku = ANY($2::text[])`,
      [empresaId, skus]
    );
    vinculosPorSku = Object.fromEntries(rows.map((r) => [r.sku, r]));
  }

  const porProdutoBase = {};
  const pendentes = [];
  const detalhes = [];

  for (const item of itens) {
    const quantidade = Number(item.quantidade) || 0;
    const vinculo = item.sku ? vinculosPorSku[item.sku] : null;

    if (!vinculo) {
      pendentes.push({ sku: item.sku || null, quantidade });
      detalhes.push({ sku: item.sku || null, quantidade, vinculado: false });
      continue;
    }

    const quantidadeFisica = quantidade * vinculo.multiplicador;
    const chave = vinculo.produto_base_id;
    if (!porProdutoBase[chave]) {
      porProdutoBase[chave] = {
        produtoBaseId: vinculo.produto_base_id,
        codigo: vinculo.produto_base_codigo,
        nome: vinculo.produto_base_nome,
        custo: vinculo.produto_base_custo === null ? null : Number(vinculo.produto_base_custo),
        quantidadeFisica: 0,
      };
    }
    porProdutoBase[chave].quantidadeFisica += quantidadeFisica;
    detalhes.push({
      sku: item.sku,
      quantidade,
      vinculado: true,
      produtoBaseCodigo: vinculo.produto_base_codigo,
      multiplicador: vinculo.multiplicador,
      quantidadeFisica,
    });
  }

  return {
    porProdutoBase: Object.values(porProdutoBase),
    pendentes,
    detalhes,
  };
}

module.exports = { converterItens, SELECT_VINCULO };
